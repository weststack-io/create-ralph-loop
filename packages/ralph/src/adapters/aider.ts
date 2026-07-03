import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, commandExists } from "../util/proc";
import type { AgentRequest, AgentResult, AgentUsage, RunnerAdapter, PermissionTier } from "./types";

/**
 * Aider adapter — primarily a coder adapter, and the documented path to LOCAL
 * LLMs: set the role's model to e.g. "ollama/qwen2.5-coder" (with OLLAMA_API_BASE
 * in devServer.env / process env) or "openrouter/…". The harness owns git, so we
 * pass --no-auto-commits and let the loop commit/revert.
 *
 * Flag assumptions (centralized here; may need tuning to the installed aider):
 *  - one-shot non-interactive run via --message-file (avoids argv length limits)
 *  - --yes-always auto-confirms; --no-auto-commits / --no-gitignore keep git ours
 */
export class AiderAdapter implements RunnerAdapter {
  readonly name = "aider";

  async isAvailable(): Promise<boolean> {
    return commandExists("aider");
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    const tmp = path.join(os.tmpdir(), `ralph-aider-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(tmp, req.prompt);
    try {
      const args = [
        "--yes-always",
        "--no-auto-commits",
        "--no-pretty",
        "--no-stream",
        ...(req.model ? ["--model", req.model] : []),
        ...permissionToAiderArgs(req.permissionTier),
        "--message-file",
        tmp,
        ...(req.extraArgs ?? []),
      ];
      const res = await run("aider", args, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        onStdout: req.onOutput,
      });
      return {
        exitCode: res.code,
        rawOutput: res.combined,
        usage: parseAiderOutput(res.stdout).usage,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Aider is an editor; readonly maps to a chat-only run (no file edits). */
export function permissionToAiderArgs(tier: PermissionTier): string[] {
  return tier === "readonly" ? ["--chat-mode", "ask"] : [];
}

/**
 * Parse aider's token/cost footer, e.g.:
 *   "Tokens: 12k sent, 340 received. Cost: $0.02 message, $0.05 session."
 * Best-effort; returns undefined usage when nothing matches.
 */
export function parseAiderOutput(stdout: string): { usage?: AgentUsage } {
  const sent = /([\d.]+)\s*([km]?)\s*(?:tokens\s+)?sent/i.exec(stdout);
  const recv = /([\d.]+)\s*([km]?)\s*(?:tokens\s+)?received/i.exec(stdout);
  const cost = /Cost:\s*\$([\d.]+)\s*message/i.exec(stdout) ?? /\$([\d.]+)\s*session/i.exec(stdout);

  const inputTokens = sent ? scale(sent[1], sent[2]) : undefined;
  const outputTokens = recv ? scale(recv[1], recv[2]) : undefined;
  const costUsd = cost ? Number(cost[1]) : undefined;

  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
    return {};
  }
  return { usage: { inputTokens, outputTokens, costUsd } };
}

function scale(num: string, suffix: string): number {
  const n = Number(num);
  if (suffix?.toLowerCase() === "k") return Math.round(n * 1000);
  if (suffix?.toLowerCase() === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}
