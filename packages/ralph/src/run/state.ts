import fs from "node:fs";
import type { AgentUsage } from "../adapters/types";
import { nowIso } from "../events/types";
import { ensureRalphDir, runStatePath } from "../util/paths";

/** Accumulated usage for a single role across the run. */
export interface RoleUsage {
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Durable run-level telemetry persisted to .ralph/run-state.json. The loop
 * mutates this via RunStateStore and drives budget/stall decisions from it.
 */
export interface RunState {
  runId: string;
  startedAt: string;
  updatedAt: string;
  iteration: number;
  perRole: Record<string, RoleUsage>;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  features: { verified: number; passed: number; blocked: number; total: number };
  lastProgressIteration: number; // last iteration that produced a verified/passed feature
  checkpointSha?: string;
  baselineFailureCounts?: Record<string, number>; // carried baseline for command gates
  done: boolean;
  haltReason?: string;
}

export class RunStateStore {
  constructor(private readonly cwd: string) {}

  /** Load persisted state; null when missing or corrupt. */
  load(): RunState | null {
    const file = runStatePath(this.cwd);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
    } catch {
      return null;
    }
  }

  /** Create, persist and return a fresh run state. */
  init(runId: string, totalFeatures: number): RunState {
    const now = nowIso();
    const state: RunState = {
      runId,
      startedAt: now,
      updatedAt: now,
      iteration: 0,
      perRole: {},
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      features: { verified: 0, passed: 0, blocked: 0, total: totalFeatures },
      lastProgressIteration: 0,
      done: false,
    };
    this.save(state);
    return state;
  }

  /** Persist state as pretty JSON, stamping updatedAt. */
  save(state: RunState): void {
    state.updatedAt = nowIso();
    ensureRalphDir(this.cwd);
    fs.writeFileSync(runStatePath(this.cwd), JSON.stringify(state, null, 2));
  }

  /**
   * Fold one agent invocation's usage into per-role and run totals, then save.
   * Undefined usage fields count as zero.
   */
  addUsage(
    state: RunState,
    role: string,
    usage: AgentUsage | undefined,
    durationMs: number
  ): void {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const costUsd = usage?.costUsd ?? 0;

    const existing = state.perRole[role];
    const role_ = existing ?? {
      invocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
    };
    role_.invocations += 1;
    role_.inputTokens += inputTokens;
    role_.outputTokens += outputTokens;
    role_.costUsd += costUsd;
    role_.durationMs += durationMs;
    state.perRole[role] = role_;

    state.totalCostUsd += costUsd;
    state.totalInputTokens += inputTokens;
    state.totalOutputTokens += outputTokens;

    this.save(state);
  }
}
