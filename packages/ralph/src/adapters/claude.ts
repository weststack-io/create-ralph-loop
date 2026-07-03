import { commandExists, run } from "../util/proc";
import type {
  AgentRequest,
  AgentResult,
  AgentUsage,
  PermissionTier,
  RunnerAdapter,
} from "./types";

/**
 * Adapter for Anthropic's `claude` CLI. We run in print mode (`-p`) with
 * `--output-format json` so the loop can recover assistant text, token usage
 * and dollar cost from a single structured payload. The prompt is piped via
 * STDIN rather than passed as an argv positional to avoid arg-length limits
 * for large prompts.
 */

/**
 * Map a permission tier to claude's `--allowedTools` value. Centralized and
 * exported so the mapping can be unit-tested independently of invocation.
 */
export function permissionToAllowedTools(tier: PermissionTier): string {
  switch (tier) {
    case "readonly":
      return "Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),mcp__playwright";
    case "edit":
      return "Read,Write,Edit,Glob,Grep,Bash(git diff:*),Bash(git log:*),mcp__playwright";
    case "full":
      return "Read,Write,Edit,Glob,Grep,Bash,mcp__playwright";
  }
}

/**
 * Parse the JSON emitted by `claude -p --output-format json`. Defensive: any
 * parse failure or unexpected shape degrades to raw text with no usage, never
 * throwing.
 */
export function parseClaudeJsonOutput(stdout: string): {
  text: string;
  usage?: AgentUsage;
  isError: boolean;
  structured?: unknown;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout, isError: false };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { text: stdout, isError: false, structured: parsed };
  }

  const obj = parsed as Record<string, unknown>;

  const text = typeof obj.result === "string" ? obj.result : stdout;
  const isError = obj.is_error === true;

  let usage: AgentUsage | undefined;
  const rawUsage =
    obj.usage && typeof obj.usage === "object"
      ? (obj.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = rawUsage && typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : undefined;
  const outputTokens = rawUsage && typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : undefined;
  const costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined;

  if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
    usage = { inputTokens, outputTokens, costUsd };
  }

  return { text, usage, isError, structured: parsed };
}

export class ClaudeAdapter implements RunnerAdapter {
  readonly name = "claude";

  isAvailable(): Promise<boolean> {
    return commandExists("claude");
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    const args: string[] = ["-p", "--output-format", "json"];
    if (req.model) {
      args.push("--model", req.model);
    }
    args.push("--allowedTools", permissionToAllowedTools(req.permissionTier));
    if (req.extraArgs?.length) {
      args.push(...req.extraArgs);
    }

    const res = await run("claude", args, {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      onStdout: req.onOutput,
    });

    const parsed = parseClaudeJsonOutput(res.stdout);

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
