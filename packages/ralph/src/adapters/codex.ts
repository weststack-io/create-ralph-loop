import { commandExists, run } from "../util/proc";
import type {
  AgentRequest,
  AgentResult,
  AgentUsage,
  PermissionTier,
  RunnerAdapter,
} from "./types";

/**
 * Adapter for OpenAI's `codex` CLI. We invoke `codex exec --json` with the
 * prompt piped via STDIN and consume the JSONL event stream for the assistant
 * message and token usage.
 *
 * FLAG ASSUMPTIONS (may need tuning against the installed codex version — kept
 * centralized here so there is a single place to adjust):
 *  - `exec` is the non-interactive subcommand; `--json` selects JSONL events.
 *  - permission tiers map to sandbox/approval flags:
 *      readonly → --sandbox read-only
 *      edit     → --sandbox workspace-write
 *      full     → --dangerously-bypass-approvals-and-sandbox
 *        (the non-interactive equivalent of the interactive loop's `--yolo`).
 *  - `--model <m>` selects the model when provided.
 */

/**
 * Map a permission tier to codex sandbox/approval argv. Exported for testing.
 */
export function permissionToSandboxArgs(tier: PermissionTier): string[] {
  switch (tier) {
    case "readonly":
      return ["--sandbox", "read-only"];
    case "edit":
      return ["--sandbox", "workspace-write"];
    case "full":
      return ["--dangerously-bypass-approvals-and-sandbox"];
  }
}

function coerceNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Pull input/output token counts out of a codex event, handling a couple of
 * observed shapes: flat `input_tokens`/`output_tokens`, or nested under
 * `usage` / `token_count` (which may itself use `prompt_tokens`/
 * `completion_tokens`). Returns undefined when nothing usable is found.
 */
function extractTokens(obj: Record<string, unknown>): { input?: number; output?: number } | undefined {
  const candidates: Array<Record<string, unknown>> = [obj];
  for (const key of ["usage", "token_count", "tokens"]) {
    const nested = obj[key];
    if (nested && typeof nested === "object") {
      candidates.push(nested as Record<string, unknown>);
    }
  }

  for (const c of candidates) {
    const input =
      coerceNumber(c.input_tokens) ?? coerceNumber(c.prompt_tokens) ?? coerceNumber(c.input);
    const output =
      coerceNumber(c.output_tokens) ?? coerceNumber(c.completion_tokens) ?? coerceNumber(c.output);
    if (input !== undefined || output !== undefined) {
      return { input, output };
    }
  }
  return undefined;
}

/**
 * Extract a human-readable assistant message from a codex event, tolerating a
 * few shapes: `{ message }`, `{ text }`, `{ delta }`, or nested
 * `{ msg: { message | text } }` / `{ content: "..." }`.
 */
function extractMessage(obj: Record<string, unknown>): string | undefined {
  const direct =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.text === "string" && obj.text) ||
    (typeof obj.content === "string" && obj.content) ||
    (typeof obj.delta === "string" && obj.delta);
  if (direct) return direct;

  const msg = obj.msg;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    const nested =
      (typeof m.message === "string" && m.message) ||
      (typeof m.text === "string" && m.text) ||
      (typeof m.content === "string" && m.content);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Parse codex `--json` JSONL output. Best-effort and defensive: scans lines,
 * JSON.parses each, keeps the last event carrying assistant text, and sums any
 * token usage found. If no line parses as JSON, returns the raw stdout as text.
 */
export function parseCodexOutput(stdout: string): {
  text: string;
  usage?: AgentUsage;
  structured?: unknown;
} {
  const lines = stdout.split(/\r?\n/);
  const events: unknown[] = [];
  let lastText: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let sawTokens = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    events.push(evt);
    if (evt === null || typeof evt !== "object") continue;
    const obj = evt as Record<string, unknown>;

    const msg = extractMessage(obj);
    if (msg !== undefined) lastText = msg;

    const tokens = extractTokens(obj);
    if (tokens) {
      if (tokens.input !== undefined) inputTokens = (inputTokens ?? 0) + tokens.input;
      if (tokens.output !== undefined) outputTokens = (outputTokens ?? 0) + tokens.output;
      sawTokens = true;
    }
  }

  if (events.length === 0) {
    return { text: stdout };
  }

  const usage: AgentUsage | undefined = sawTokens ? { inputTokens, outputTokens } : undefined;

  return {
    text: lastText ?? stdout,
    usage,
    structured: events,
  };
}

export class CodexAdapter implements RunnerAdapter {
  readonly name = "codex";

  isAvailable(): Promise<boolean> {
    return commandExists("codex");
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    const args: string[] = ["exec", "--json"];
    if (req.model) {
      args.push("--model", req.model);
    }
    args.push(...permissionToSandboxArgs(req.permissionTier));
    if (req.extraArgs?.length) {
      args.push(...req.extraArgs);
    }

    const res = await run("codex", args, {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      onStdout: req.onOutput,
    });

    const parsed = parseCodexOutput(res.stdout);

    return {
      exitCode: res.code,
      rawOutput: res.combined,
      structured: parsed.structured,
      usage: parsed.usage,
      durationMs: res.durationMs,
      timedOut: res.timedOut,
    };
  }
}
