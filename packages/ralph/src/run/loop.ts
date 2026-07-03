import { captureBaseline } from "../gates";
import { commitAll, rollbackTo } from "../util/git";
import { checkBudget, checkStall } from "../budget/tracker";
import { nowIso } from "../events/types";
import { log, color } from "../util/logger";
import { runIteration } from "./iteration";
import type { RunContext, IterationFailure } from "./types";
import type { FeatureStatus } from "../features/schema";

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
