import type { GateContext } from "../gates/types";
import type { BaselineSnapshot } from "../gates/types";
import { renderPrompt, type GardenerPromptContext } from "../prompts/render";
import { stageAll, stagedFiles, stagedDiffStat } from "../util/git";
import { ensureCheckpoint, rollback, acceptCommit } from "../run/checkpoint";
import { nowIso } from "../events/types";
import { log } from "../util/logger";
import type { RunContext } from "../run/types";

/**
 * Periodic "gardening" pass (OpenAI harness-engineering pattern) to fight the
 * dominant failure mode of Ralph loops — entropy / "AI slop". Runs a full-
 * permission cleanup agent, then gates it exactly like a coding turn: accept
 * (commit) if the mechanical gates pass, hard-revert otherwise. It touches no
 * feature status and runs no verifier.
 */
export async function runGarden(
  ctx: RunContext,
  baseline: BaselineSnapshot,
): Promise<{ committed: boolean; detail: string }> {
  const { cwd, config, store, eventLog, stateStore, state } = ctx;
  const iteration = state.iteration;

  const checkpointSha = await ensureCheckpoint(cwd, `garden ${iteration}`);
  const featuresHashBefore = store.snapshotHash();

  const context: GardenerPromptContext = {
    projectName: ctx.projectName,
    specDir: config.specDir,
  };
  const prompt = renderPrompt("gardener", context, { cwd, specDir: config.specDir });

  log.step(`Gardening pass (entropy cleanup) at iteration ${iteration}…`);
  const res = await ctx.gardener.adapter.invoke({
    prompt,
    cwd,
    role: "gardener",
    model: ctx.gardener.role.model,
    permissionTier: ctx.gardener.role.permissionTier,
    timeoutMs: ctx.agentTimeoutMs,
    onOutput: ctx.stream ? (c) => log.raw(c) : undefined,
  });
  stateStore.addUsage(state, "gardener", res.usage, res.durationMs);

  await stageAll(cwd);
  const changedFiles = await stagedFiles(cwd);
  const diffStat = await stagedDiffStat(cwd);
  const featuresHashAfter = store.snapshotHash();

  if (changedFiles.length === 0) {
    return { committed: false, detail: "no changes" };
  }

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
  for (const gate of ctx.gates) {
    const result = await gate.run(gateCtx);
    eventLog.append({ type: "gate_result", ts: nowIso(), iteration, gate: `garden:${result.gate}`, passed: result.passed, newFailures: result.newFailures, detail: result.detail });
    if (!result.passed) {
      await rollback(cwd, checkpointSha);
      log.warn(`  gardening reverted (gate ${result.gate} failed)`);
      return { committed: false, detail: `gate ${result.gate} failed` };
    }
  }

  const sha = await acceptCommit(cwd, "ralph(garden): entropy cleanup");
  log.success(`  gardening committed ${sha.slice(0, 8)} (${changedFiles.length} files)`);
  return { committed: true, detail: `committed ${sha.slice(0, 8)}` };
}
