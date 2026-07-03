import type { RalphConfig } from "../config/schema";

/**
 * Mechanical gates run by the harness (not the agent) after each coding turn.
 * The loop constructs a GateContext, runs each enabled gate, and reverts the
 * iteration if any gate fails.
 */

/**
 * Per-gate baseline captured before the coder runs, so command gates can be
 * "baseline-relative": a pre-existing failure does not block, only NEW failures
 * introduced by this iteration do (hermes-agent pattern).
 */
export interface BaselineSnapshot {
  /** gate name → whether its command passed (exit 0) at baseline. */
  passed: Record<string, boolean>;
  /** gate name → parsed failure count at baseline (best-effort). */
  failureCounts: Record<string, number>;
  /** gate name → parsed failure signatures at baseline (best-effort). */
  failures: Record<string, string[]>;
}

export function emptyBaseline(): BaselineSnapshot {
  return { passed: {}, failureCounts: {}, failures: {} };
}

export interface GateContext {
  cwd: string;
  config: RalphConfig;
  /** features.json path relative to cwd (for the integrity gate). */
  featuresRelPath: string;
  /** Staged changed files (relative paths), computed by the loop. */
  changedFiles: string[];
  /** Staged diff stat vs the checkpoint, computed by the loop. */
  diffStat: { files: number; insertions: number; deletions: number };
  /** Hash of features.json at checkpoint and now (for the integrity gate). */
  featuresHashBefore: string;
  featuresHashAfter: string;
  baseline: BaselineSnapshot;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  /** New failure signatures introduced this iteration (baseline-relative gates). */
  newFailures?: string[];
  detail: string;
}

export interface Gate {
  readonly name: string;
  run(ctx: GateContext): Promise<GateResult>;
}
