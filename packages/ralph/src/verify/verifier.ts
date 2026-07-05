import type { RunnerAdapter, AgentUsage } from "../adapters/types";
import type { ResolvedRole } from "../config/schema";
import type { Feature } from "../features/schema";
import { renderPrompt, type VerifierPromptContext } from "../prompts/render";
import { parseRalphVerdict, type RalphVerdict } from "../prompts/blocks";

/**
 * Independent, fail-closed verification. The verifier runs in a FRESH context
 * (no implementer history), read-only, ideally on a different/cheaper model.
 * Unparseable or ambiguous output is treated as "inconclusive" → the loop
 * rejects the change (no agent grades its own work).
 */

export interface VerifierOptions {
  adapter: RunnerAdapter;
  role: ResolvedRole;
  cwd: string;
  specDir: string;
  projectName: string;
  devPort: number;
  feature: Feature;
  diffSummary: string;
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
}

export interface VerifierOutcome {
  verdict: "pass" | "fail" | "inconclusive";
  concerns: string[];
  steps: RalphVerdict["steps"];
  usage?: AgentUsage;
  durationMs: number;
  raw: string;
}

export async function runVerifier(opts: VerifierOptions): Promise<VerifierOutcome> {
  const context: VerifierPromptContext = {
    projectName: opts.projectName,
    devPort: opts.devPort,
    specDir: opts.specDir,
    feature: opts.feature,
    diffSummary: opts.diffSummary,
  };
  const prompt = renderPrompt("verifier", context, { cwd: opts.cwd, specDir: opts.specDir });

  const res = await opts.adapter.invoke({
    prompt,
    cwd: opts.cwd,
    role: "verifier",
    model: opts.role.model,
    permissionTier: "readonly",
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });

  const parsed = parseRalphVerdict(res.rawOutput);
  if (!parsed.ok) {
    return {
      verdict: "inconclusive",
      concerns: [`verifier output could not be parsed (${parsed.error})`],
      steps: [],
      usage: res.usage,
      durationMs: res.durationMs,
      raw: res.rawOutput,
    };
  }
  return {
    verdict: parsed.value.verdict,
    concerns: parsed.value.concerns,
    steps: parsed.value.steps,
    usage: res.usage,
    durationMs: res.durationMs,
    raw: res.rawOutput,
  };
}
