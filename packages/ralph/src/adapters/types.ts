/**
 * The adapter layer abstracts over agent CLIs (claude, codex, aider, …). Each
 * adapter owns invocation flags, model selection, permission mapping and
 * output/usage parsing. The orchestrator only ever talks to this interface, so
 * adding a provider (or a local-LLM CLI) never touches the loop.
 */

export type Role = "coder" | "verifier" | "planner" | "replanner" | "gardener";

/**
 * Permission tiers are mapped by each adapter to its own flags:
 *  - readonly: read/search/inspect only (verifier, replanner)
 *  - edit:     read + write files, no arbitrary shell (planner)
 *  - full:     read + write + shell (coder; maps to codex --yolo / claude Bash)
 */
export type PermissionTier = "readonly" | "edit" | "full";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported dollar cost for this invocation, when available. */
  costUsd?: number;
}

export interface AgentRequest {
  prompt: string;
  cwd: string;
  role: Role;
  model?: string;
  permissionTier: PermissionTier;
  timeoutMs: number;
  /** Extra provider-specific args appended verbatim after the adapter's own. */
  extraArgs?: string[];
  /** Stream stdout live to this sink (for `ralph run` console). */
  onOutput?: (chunk: string) => void;
}

export interface AgentResult {
  exitCode: number | null;
  /** Full captured text output (stdout, plus stderr appended). */
  rawOutput: string;
  /** Parsed structured payload when the adapter used a JSON output format. */
  structured?: unknown;
  /** Token/cost usage when the adapter can extract it; undefined otherwise. */
  usage?: AgentUsage;
  durationMs: number;
  timedOut: boolean;
}

export interface RunnerAdapter {
  /** Stable identifier used in config `roles[*].adapter`. */
  readonly name: string;
  /** True if the underlying CLI is installed and usable. */
  isAvailable(): Promise<boolean>;
  /** Run one agent turn to completion. */
  invoke(req: AgentRequest): Promise<AgentResult>;
}
