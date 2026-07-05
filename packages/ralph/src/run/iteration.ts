import type { Feature, VerificationRecord } from "../features/schema";
import type { BaselineSnapshot, GateContext } from "../gates/types";
import { renderPrompt, type CodingPromptContext } from "../prompts/render";
import { parseRalphResult } from "../prompts/blocks";
import { runVerifier } from "../verify/verifier";
import { stageAll, stagedFiles, stagedDiffStat } from "../util/git";
import { ensureCheckpoint, rollback, acceptCommit } from "./checkpoint";
import { nowIso } from "../events/types";
import { log, color } from "../util/logger";
import type { RunContext, IterationResult, IterationFailure } from "./types";

/**
 * Execute a single coding iteration for one feature:
 *   checkpoint → coder → stage → mechanical gates → independent verifier
 *   → accept (commit + transition) OR revert (fail-closed).
 *
 * On any failure the working tree is hard-reverted to the checkpoint; feature
 * bookkeeping (attempts/blocked) is left to the loop. On accept, the feature is
 * transitioned and committed atomically here (code + features.json in one commit).
 */
export async function runIteration(
  ctx: RunContext,
  feature: Feature,
  attempt: number,
  baseline: BaselineSnapshot,
  previousFailure: IterationFailure | undefined,
): Promise<IterationResult> {
  const { cwd, config, store, eventLog, stateStore, state } = ctx;
  const iteration = state.iteration;
  const devPort = config.devServer.port;

  // 1. Checkpoint (clean, known-good commit to revert to).
  const checkpointSha = await ensureCheckpoint(cwd, `iter ${iteration} pre ${feature.id}`);
  state.checkpointSha = checkpointSha;
  eventLog.append({ type: "checkpoint", ts: nowIso(), iteration, sha: checkpointSha });

  const featuresHashBefore = store.snapshotHash();

  // 2. Render + invoke the coder.
  const context: CodingPromptContext = {
    projectName: ctx.projectName,
    projectDescription: ctx.projectDescription,
    devPort,
    specDir: config.specDir,
    feature,
    iteration,
    attempt,
    previousFailure: previousFailure
      ? {
          gates: previousFailure.gates,
          verifierConcerns: previousFailure.verifierConcerns,
          detail: previousFailure.detail,
        }
      : undefined,
    recentProgress: buildRecentProgress(ctx),
  };
  const prompt = renderPrompt("coding", context, { cwd, specDir: config.specDir });

  log.step(`Iteration ${iteration} · ${color.bold(feature.id)} (attempt ${attempt}) — ${feature.description}`);

  const coderRes = await ctx.coder.adapter.invoke({
    prompt,
    cwd,
    role: "coder",
    model: ctx.coder.role.model,
    permissionTier: ctx.coder.role.permissionTier,
    timeoutMs: ctx.agentTimeoutMs,
    onOutput: ctx.stream ? (c) => log.raw(c) : undefined,
  });
  stateStore.addUsage(state, "coder", coderRes.usage, coderRes.durationMs);

  const claim = parseRalphResult(coderRes.rawOutput);
  const claimedOutcome = claim.ok ? claim.value.outcome : undefined;
  const summary = claim.ok ? claim.value.summary : "(no result block)";

  eventLog.append({
    type: "agent_result",
    ts: nowIso(),
    iteration,
    role: "coder",
    featureId: feature.id,
    claimedOutcome,
    exitCode: coderRes.exitCode,
    timedOut: coderRes.timedOut,
    durationMs: coderRes.durationMs,
    usage: coderRes.usage,
  });

  // 3. Stage and measure the change.
  await stageAll(cwd);
  const changedFiles = await stagedFiles(cwd);
  const diffStat = await stagedDiffStat(cwd);
  const featuresHashAfter = store.snapshotHash();

  // Agent explicitly gave up on this feature.
  if (claimedOutcome === "blocked") {
    await rollback(cwd, checkpointSha);
    const detail = `agent reported blocked: ${claim.ok ? claim.value.blockers.join("; ") || summary : summary}`;
    return { outcome: "blocked", detail };
  }

  if (changedFiles.length === 0) {
    return {
      outcome: "no_change",
      detail: "coder produced no file changes",
      failure: { gates: [], verifierConcerns: [], detail: "no changes were made" },
    };
  }

  // 4. Mechanical gates.
  const gateCtx: GateContext = {
    cwd,
    config,
    featuresRelPath: ctx.featuresRelPath,
    changedFiles,
    diffStat,
    featuresHashBefore,
    featuresHashAfter,
    baseline,
  };
  const failedGates: string[] = [];
  const gateFailureDetails: string[] = [];
  for (const gate of ctx.gates) {
    const result = await gate.run(gateCtx);
    eventLog.append({
      type: "gate_result",
      ts: nowIso(),
      iteration,
      gate: result.gate,
      passed: result.passed,
      newFailures: result.newFailures,
      detail: result.detail,
    });
    if (result.passed) {
      log.dim(`  gate ${result.gate}: ok`);
    } else {
      failedGates.push(result.gate);
      gateFailureDetails.push(`${result.gate}: ${result.detail}`);
      log.warn(`  gate ${result.gate}: FAILED — ${result.detail}`);
    }
  }

  if (failedGates.length > 0) {
    await rollback(cwd, checkpointSha);
    eventLog.append({ type: "revert", ts: nowIso(), iteration, toSha: checkpointSha, reason: `gates failed: ${failedGates.join(", ")}` });
    return {
      outcome: "gate_failed",
      detail: `gates failed: ${failedGates.join(", ")}`,
      failure: { gates: failedGates, verifierConcerns: [], detail: gateFailureDetails.join("\n") },
    };
  }

  // 5. Independent verifier (fail-closed).
  let verification: VerificationRecord | null = null;
  let acceptedStatus: "verified" | "passed" = "passed";

  if (config.verify.enabled) {
    const diffSummary =
      `Changed files (${diffStat.files}, +${diffStat.insertions}/-${diffStat.deletions}):\n` +
      changedFiles.map((f) => ` - ${f}`).join("\n");

    log.step(`  verifying ${feature.id} (${ctx.verifier.role.adapter}/${ctx.verifier.role.model ?? "default"})`);
    const verdict = await runVerifier({
      adapter: ctx.verifier.adapter,
      role: ctx.verifier.role,
      cwd,
      specDir: config.specDir,
      projectName: ctx.projectName,
      devPort,
      feature,
      diffSummary,
      timeoutMs: ctx.agentTimeoutMs,
      onOutput: ctx.stream ? (c) => log.raw(c) : undefined,
    });
    stateStore.addUsage(state, "verifier", verdict.usage, verdict.durationMs);
    eventLog.append({
      type: "verifier_result",
      ts: nowIso(),
      iteration,
      featureId: feature.id,
      verdict: verdict.verdict,
      concerns: verdict.concerns,
      durationMs: verdict.durationMs,
      usage: verdict.usage,
    });

    if (verdict.verdict !== "pass") {
      await rollback(cwd, checkpointSha);
      eventLog.append({ type: "revert", ts: nowIso(), iteration, toSha: checkpointSha, reason: `verifier ${verdict.verdict}` });
      log.warn(`  verifier ${verdict.verdict}: ${verdict.concerns.join("; ") || "(no concerns given)"}`);
      return {
        outcome: "verifier_failed",
        detail: `verifier returned ${verdict.verdict}`,
        failure: { gates: [], verifierConcerns: verdict.concerns, detail: verdict.concerns.join("\n") || `verdict ${verdict.verdict}` },
      };
    }

    verification = {
      verdict: "pass",
      verifier: { adapter: ctx.verifier.role.adapter, model: ctx.verifier.role.model },
      at: nowIso(),
      stepResults: verdict.steps,
      concerns: verdict.concerns,
    };
    acceptedStatus = "verified";
  }

  // 6. Accept: transition + atomic commit (code + features.json).
  store.transition(feature.id, acceptedStatus, { verification });
  const commitSha = await acceptCommit(cwd, `ralph(${feature.id}): ${acceptedStatus} — ${truncate(summary, 72)}`);
  eventLog.append({ type: "feature_transition", ts: nowIso(), featureId: feature.id, from: feature.status, to: acceptedStatus, reason: `accepted at ${commitSha.slice(0, 8)}` });
  log.success(`  ${feature.id} ${acceptedStatus} · committed ${commitSha.slice(0, 8)}`);

  return { outcome: acceptedStatus, detail: summary };
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

function buildRecentProgress(ctx: RunContext): string | undefined {
  const events = ctx.eventLog.read();
  const transitions = events
    .filter((e) => e.type === "feature_transition")
    .slice(-6)
    .map((e) => {
      const t = e as { featureId?: string; to?: string };
      return `- ${t.featureId} → ${t.to}`;
    });
  return transitions.length ? transitions.join("\n") : undefined;
}
