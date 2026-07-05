import { z } from "zod";
import type { AgentUsage, Role } from "../adapters/types";
import type { FeatureStatus } from "../features/schema";

/**
 * Typed, append-only run events written to .ralph/progress.jsonl. Replaces the
 * free-text progress.txt as the load-bearing record; `ralph status` renders it.
 * Writers use the typed union; readers parse leniently (schema below) so old
 * logs stay readable across versions.
 */

export interface BaseEvent {
  type: string;
  ts: string; // ISO 8601
}

export interface RunStartEvent extends BaseEvent {
  type: "run_start";
  runId: string;
  featureCount: number;
  roles: Record<string, { adapter: string; model?: string }>;
  budgets?: { maxCostUsd?: number; maxIterations?: number; maxWallClockMinutes?: number };
}

export interface IterationStartEvent extends BaseEvent {
  type: "iteration_start";
  iteration: number;
  featureId: string;
  featureDescription: string;
  attempt: number;
}

export interface AgentResultEvent extends BaseEvent {
  type: "agent_result";
  iteration: number;
  role: Role;
  featureId?: string;
  claimedOutcome?: "implemented" | "partial" | "blocked";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  usage?: AgentUsage;
}

export interface GateResultEvent extends BaseEvent {
  type: "gate_result";
  iteration: number;
  gate: string;
  passed: boolean;
  newFailures?: string[];
  detail: string;
}

export interface VerifierResultEvent extends BaseEvent {
  type: "verifier_result";
  iteration: number;
  featureId: string;
  verdict: "pass" | "fail" | "inconclusive";
  concerns: string[];
  durationMs: number;
  usage?: AgentUsage;
}

export interface FeatureTransitionEvent extends BaseEvent {
  type: "feature_transition";
  featureId: string;
  from: FeatureStatus;
  to: FeatureStatus;
  reason?: string;
}

export interface CheckpointEvent extends BaseEvent {
  type: "checkpoint";
  iteration: number;
  sha: string;
}

export interface RevertEvent extends BaseEvent {
  type: "revert";
  iteration: number;
  toSha: string;
  reason: string;
}

export interface BudgetEvent extends BaseEvent {
  type: "budget";
  metric: "cost" | "iterations" | "time";
  spent: number;
  limit: number;
  halted: boolean;
}

export interface StallEvent extends BaseEvent {
  type: "stall";
  iterationsWithoutProgress: number;
  action: "notify" | "replan" | "halt";
}

export interface ReplanEvent extends BaseEvent {
  type: "replan";
  iteration: number;
  operations: string[];
  summary?: string;
}

export interface NotifyEvent extends BaseEvent {
  type: "notify";
  event: string;
  message: string;
  sink: string;
}

export interface HaltEvent extends BaseEvent {
  type: "halt";
  reason: string;
}

export interface RunEndEvent extends BaseEvent {
  type: "run_end";
  reason: string;
  verified: number;
  passed: number;
  blocked: number;
  total: number;
  durationMs: number;
  totalCostUsd?: number;
}

export type RunEvent =
  | RunStartEvent
  | IterationStartEvent
  | AgentResultEvent
  | GateResultEvent
  | VerifierResultEvent
  | FeatureTransitionEvent
  | CheckpointEvent
  | RevertEvent
  | BudgetEvent
  | StallEvent
  | ReplanEvent
  | NotifyEvent
  | HaltEvent
  | RunEndEvent;

/** Lenient reader schema — tolerates unknown/newer event shapes. */
export const RunEventSchema = z
  .object({ type: z.string(), ts: z.string() })
  .passthrough();

export function nowIso(): string {
  return new Date().toISOString();
}
