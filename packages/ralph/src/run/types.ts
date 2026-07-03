import type { RalphConfig, ResolvedRole } from "../config/schema";
import type { RunnerAdapter } from "../adapters/types";
import type { Gate } from "../gates/types";
import type { BaselineSnapshot } from "../gates/types";
import { FeatureStore } from "../features/store";
import { DevServerManager } from "../devserver/manager";
import { EventLog } from "../events/log";
import { RunStateStore, type RunState } from "./state";
import { NotificationHub } from "../notify";

/** Everything an iteration/loop needs, assembled once by the CLI `run` command. */
export interface RunContext {
  cwd: string;
  config: RalphConfig;
  projectName: string;
  projectDescription?: string;
  /** features.json path relative to cwd (for the integrity gate + prompts). */
  featuresRelPath: string;

  store: FeatureStore;
  devServer: DevServerManager;
  eventLog: EventLog;
  stateStore: RunStateStore;
  state: RunState;
  gates: Gate[];
  notifier: NotificationHub;

  coder: { adapter: RunnerAdapter; role: ResolvedRole };
  verifier: { adapter: RunnerAdapter; role: ResolvedRole };

  /** Stream agent output to the console. */
  stream: boolean;
  /** Per-agent invocation timeout. */
  agentTimeoutMs: number;
}

export type IterationOutcome =
  | "verified"
  | "passed"
  | "blocked"
  | "gate_failed"
  | "verifier_failed"
  | "no_change"
  | "error";

export interface IterationFailure {
  gates: string[];
  verifierConcerns: string[];
  detail: string;
}

export interface IterationResult {
  outcome: IterationOutcome;
  detail: string;
  /** Present on retriable failures; fed into the next attempt's prompt. */
  failure?: IterationFailure;
}

export interface FeatureFailureMemory {
  get(id: string): IterationFailure | undefined;
  set(id: string, f: IterationFailure): void;
  delete(id: string): void;
}

export type { BaselineSnapshot };
