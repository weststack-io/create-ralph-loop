import { captureBaseline } from "../gates";
import { commitAll, rollbackTo } from "../util/git";
import { run as runProc } from "../util/proc";
import { checkBudget, checkStall } from "../budget/tracker";
import { nowIso } from "../events/types";
import { log, color } from "../util/logger";
import { runIteration } from "./iteration";
import { runReplan } from "../replan/replanner";
import { runGarden } from "../garden/gardener";
import type { RunContext, IterationFailure } from "./types";
import type { FeatureStatus } from "../features/schema";
import type { BaselineSnapshot } from "../gates/types";

export interface RunOptions {
  /** CLI override for the iteration cap (falls back to config.budgets.maxIterations). */
  maxIterations?: number;
}

export interface RunSummary {
  reason: string;
  iterations: number;
  verified: number;
  passed: number;
  blocked: number;
  total: number;
  totalCostUsd: number;
  durationMs: number;
}

/**
 * Drive the autonomous loop: select the next DAG-eligible feature, run one
 * guarded iteration, apply bookkeeping, and stop on completion, budget, or
 * stall. Feature selection, retries and blocking live here; per-iteration
 * code lifecycle lives in runIteration.
 */
export async function runLoop(ctx: RunContext, opts: RunOptions = {}): Promise<RunSummary> {
  const { cwd, config, store, eventLog, stateStore, state, notifier } = ctx;
  const unlockOn = config.verify.unlockOn;
  const effectiveMax = opts.maxIterations ?? config.budgets.maxIterations;
  const startedAt = Date.now();

  eventLog.append({
    type: "run_start",
    ts: nowIso(),
    runId: state.runId,
    featureCount: store.counts().total,
    roles: {
      coder: { adapter: ctx.coder.role.adapter, model: ctx.coder.role.model },
      verifier: { adapter: ctx.verifier.role.adapter, model: ctx.verifier.role.model },
    },
    budgets: config.budgets,
  });

  log.step("Capturing baseline (existing test/type failures are tolerated; only NEW ones block)…");
  let baseline = await captureBaseline(config, cwd);

  const failureMemory = new Map<string, IterationFailure>();
  let haltReason = "";

  while (true) {
    const budget = checkBudget(state, config, effectiveMax, Date.now() - startedAt);
    budget.events.forEach((e) => eventLog.append(e));
    if (budget.halt) {
      haltReason = budget.reason ?? "budget reached";
      await notifier.notify("budget", haltReason);
      break;
    }

    const feature = store.nextEligible(unlockOn);
    if (!feature) {
      const c = store.counts();
      const done = c.verified + c.passed >= c.total;
      haltReason = done
        ? "all features complete"
        : "no eligible features remain (blocked or dependency-stuck)";
      break;
    }

    state.iteration += 1;
    stateStore.save(state);
    eventLog.append({
      type: "iteration_start",
      ts: nowIso(),
      iteration: state.iteration,
      featureId: feature.id,
      featureDescription: feature.description,
      attempt: feature.attempts + 1,
    });

    let result;
    try {
      result = await runIteration(ctx, feature, feature.attempts + 1, baseline, failureMemory.get(feature.id));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`iteration ${state.iteration} threw: ${detail}`);
      if (state.checkpointSha) {
        try {
          await rollbackTo(cwd, state.checkpointSha);
        } catch {
          /* best-effort */
        }
      }
      result = {
        outcome: "error" as const,
        detail,
        failure: { gates: [], verifierConcerns: [], detail },
      };
    }

    if (result.outcome === "verified" || result.outcome === "passed") {
      failureMemory.delete(feature.id);
      state.lastProgressIteration = state.iteration;
      syncCounts(ctx);
      stateStore.save(state);
      baseline = await captureBaseline(config, cwd); // new known-good baseline
      await notifier.notify("milestone", `${feature.id} ${result.outcome}: ${result.detail}`);
    } else if (result.outcome === "blocked") {
      store.transition(feature.id, "blocked", { reason: result.detail });
      await commitFeatures(cwd, `ralph(${feature.id}): blocked`);
      failureMemory.delete(feature.id);
      syncCounts(ctx);
      stateStore.save(state);
      await notifier.notify("blocked", `${feature.id} blocked: ${result.detail}`);
    } else {
      // Retriable failure: gate_failed / verifier_failed / no_change / error.
      const attemptsNow = feature.attempts + 1;
      if (attemptsNow > config.retries.maxAttempts) {
        store.transition(feature.id, "blocked", {
          reason: `exhausted ${attemptsNow} attempts — ${result.detail}`,
          incrementAttempts: true,
        });
        await commitFeatures(cwd, `ralph(${feature.id}): blocked after ${attemptsNow} attempts`);
        failureMemory.delete(feature.id);
        syncCounts(ctx);
        stateStore.save(state);
        await notifier.notify("blocked", `${feature.id} blocked after ${attemptsNow} attempts`);
      } else {
        store.transition(feature.id, "pending", { incrementAttempts: true });
        await commitFeatures(cwd, `ralph(${feature.id}): attempt ${attemptsNow} failed`);
        failureMemory.set(
          feature.id,
          result.failure ?? { gates: [], verifierConcerns: [], detail: result.detail },
        );
        log.warn(`  ${feature.id} attempt ${attemptsNow} failed — will retry`);
      }
    }

    // Periodic self-improvement: strong-model replan of the feature DAG.
    if (config.replan.everyIterations && state.iteration % config.replan.everyIterations === 0) {
      await maybeReplan(ctx);
    }

    // Periodic entropy cleanup (gardening); refresh baseline if it committed.
    if (config.garden.everyIterations && state.iteration % config.garden.everyIterations === 0) {
      const garden = await maybeGarden(ctx, baseline);
      if (garden) baseline = await captureBaseline(config, cwd);
    }

    const stall = checkStall(state, config);
    if (stall.event) eventLog.append(stall.event);
    if (stall.stalled) {
      await notifier.notify("stall", `no progress for ${state.iteration - state.lastProgressIteration} iterations`);
    }
    if (stall.halt) {
      haltReason = `stalled: no progress for ${state.iteration - state.lastProgressIteration} iterations`;
      break;
    }
  }

  syncCounts(ctx);
  state.done = true;
  state.haltReason = haltReason;
  stateStore.save(state);

  const durationMs = Date.now() - startedAt;
  const c = store.counts();
  eventLog.append({
    type: "run_end",
    ts: nowIso(),
    reason: haltReason,
    verified: c.verified,
    passed: c.passed,
    blocked: c.blocked,
    total: c.total,
    durationMs,
    totalCostUsd: state.totalCostUsd,
  });

  const complete = c.verified + c.passed >= c.total;
  await notifier.notify(complete ? "complete" : "halt", `${haltReason} (${c.verified + c.passed}/${c.total} done)`);

  log.info("");
  log.info(
    `${color.bold("Run finished:")} ${haltReason}. ` +
      `${color.green(String(c.verified))} verified, ${c.passed} passed, ${color.yellow(String(c.blocked))} blocked of ${c.total} ` +
      `(${state.iteration} iterations, $${state.totalCostUsd.toFixed(4)}).`,
  );

  return {
    reason: haltReason,
    iterations: state.iteration,
    verified: c.verified,
    passed: c.passed,
    blocked: c.blocked,
    total: c.total,
    totalCostUsd: state.totalCostUsd,
    durationMs,
  };
}

function syncCounts(ctx: RunContext): void {
  const c = ctx.store.counts() as Record<FeatureStatus, number> & { total: number };
  ctx.state.features = {
    verified: c.verified,
    passed: c.passed,
    blocked: c.blocked,
    total: c.total,
  };
}

async function commitFeatures(cwd: string, message: string): Promise<void> {
  // The harness updated features.json (attempts/blocked); commit it so the tree
  // stays clean for the next checkpoint. No-op-safe if nothing changed.
  try {
    await commitAll(cwd, message);
  } catch {
    /* nothing staged / already clean */
  }
}

async function maybeReplan(ctx: RunContext): Promise<void> {
  const { cwd, config, store, eventLog, stateStore, state, notifier } = ctx;
  if (!(await ctx.replanner.adapter.isAvailable())) {
    log.dim("  replan skipped (replanner adapter unavailable)");
    return;
  }
  try {
    const gitLog = await buildGitLog(cwd);
    const recentEvents = buildRecentEvents(ctx);
    log.step(`Replanning (${ctx.replanner.role.adapter}/${ctx.replanner.role.model ?? "default"})…`);
    const rp = await runReplan({
      adapter: ctx.replanner.adapter,
      role: ctx.replanner.role,
      cwd,
      specDir: config.specDir,
      store,
      gitLog,
      recentEvents,
      timeoutMs: ctx.agentTimeoutMs,
      onOutput: ctx.stream ? (c) => log.raw(c) : undefined,
    });
    stateStore.addUsage(state, "replanner", rp.usage, rp.durationMs);
    eventLog.append({ type: "replan", ts: nowIso(), iteration: state.iteration, operations: rp.applied, summary: rp.summary });
    if (rp.applied.length) {
      await commitFeatures(cwd, `ralph(replan): ${rp.applied.length} change(s)`);
      syncCounts(ctx);
      stateStore.save(state);
      log.success(`  replan applied: ${rp.applied.join(", ")}`);
      await notifier.notify("replan", `replan applied ${rp.applied.length} change(s): ${rp.summary ?? ""}`);
    } else {
      log.dim(`  replan: no changes${rp.summary ? " — " + rp.summary : ""}`);
    }
  } catch (e) {
    log.warn(`  replan failed: ${(e as Error).message}`);
  }
}

async function maybeGarden(ctx: RunContext, baseline: BaselineSnapshot): Promise<boolean> {
  if (!(await ctx.gardener.adapter.isAvailable())) {
    log.dim("  gardening skipped (gardener adapter unavailable)");
    return false;
  }
  try {
    const res = await runGarden(ctx, baseline);
    return res.committed;
  } catch (e) {
    log.warn(`  gardening failed: ${(e as Error).message}`);
    return false;
  }
}

async function buildGitLog(cwd: string): Promise<string> {
  try {
    const r = await runProc("git", ["log", "--oneline", "-30"], { cwd });
    return r.stdout.trim();
  } catch {
    return "";
  }
}

function buildRecentEvents(ctx: RunContext): string {
  const events = ctx.eventLog.read().slice(-20);
  return events
    .map((e) => {
      const ev = e as unknown as Record<string, unknown>;
      const bits = [ev.type, ev.featureId, ev.gate, ev.verdict, ev.outcome, ev.reason]
        .filter((x) => x !== undefined && x !== null)
        .join(" ");
      return `- ${bits}`;
    })
    .join("\n");
}
