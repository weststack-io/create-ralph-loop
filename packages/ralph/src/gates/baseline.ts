import { runShell } from "../util/proc";
import type { RalphConfig, GateCommandConfig } from "../config/schema";
import type { BaselineSnapshot } from "./types";
import { emptyBaseline } from "./types";

/**
 * Baseline capture + command evaluation for the command gates (typecheck/test/
 * build). Everything here is best-effort and deterministic: failure "signatures"
 * are stable strings so that a set-diff against the baseline reveals only the
 * failures a coding turn newly introduced.
 */

export interface CommandEval {
  passed: boolean;
  failureCount: number;
  failures: string[];
}

/** Run a configured gate command and parse its failure signatures. */
export async function evaluateCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandEval> {
  const res = await runShell(command, { cwd, timeoutMs });
  const passed = res.code === 0;
  if (passed) return { passed: true, failureCount: 0, failures: [] };
  // A failing command always yields at least the generic fallback signature,
  // even when it emitted no parseable output (e.g. a bare non-zero exit).
  let failures = parseFailures(command, res.combined);
  if (failures.length === 0) failures = [`${command} exited non-zero`];
  return { passed: false, failureCount: failures.length, failures };
}

const TSC_ERROR_RE = /\S.*error TS\d+.*/;
// vitest/jest failing test lines, e.g. "× adds numbers" / "✕ adds" / "FAIL src/x".
const FAIL_TITLE_RE = /^\s*(?:[×✕✗]|FAIL|✖)\s+(.*\S)\s*$/;
// Summary line variants: "Tests: 1 failed, 3 passed" or "1 failed".
const SUMMARY_FAILED_RE = /(\d+)\s+failed/i;

/**
 * Best-effort, deterministic extraction of failure signatures from a gate
 * command's combined output. Used both at baseline and post-turn; only the
 * set-difference of signatures matters, so exact wording need not be perfect.
 */
export function parseFailures(command: string, output: string): string[] {
  const cmd = command.toLowerCase();
  const text = output ?? "";

  // --- tsc ---------------------------------------------------------------
  if (cmd.includes("tsc")) {
    const seen = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (TSC_ERROR_RE.test(line)) seen.add(line);
    }
    if (seen.size > 0) return [...seen];
  }

  // --- jest / vitest -----------------------------------------------------
  const looksLikeTestRunner =
    cmd.includes("jest") || cmd.includes("vitest") || /\bTests:/.test(text);
  if (looksLikeTestRunner) {
    const titles = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(FAIL_TITLE_RE);
      if (m) titles.add(m[1].trim());
    }
    if (titles.size > 0) return [...titles];

    // No parseable titles — fall back to the summary "N failed" count and
    // synthesize N generic signatures so the count is still meaningful.
    const summary = text.match(SUMMARY_FAILED_RE);
    if (summary) {
      const n = Number.parseInt(summary[1], 10);
      if (n > 0) {
        return Array.from({ length: n }, (_, i) => `test-failure-${i + 1}`);
      }
    }
  }

  // --- fallback ----------------------------------------------------------
  if (text.trim() === "") return [];
  return [`${command} exited non-zero`];
}

/**
 * Capture the pre-turn baseline for every ENABLED, baseline-relative command
 * gate so the loop can later tell newly-introduced failures from pre-existing
 * ones. Disabled gates (config === false) and non-baseline-relative gates are
 * skipped.
 */
export async function captureBaseline(config: RalphConfig, cwd: string): Promise<BaselineSnapshot> {
  const snapshot = emptyBaseline();

  const commandGates: Array<[string, GateCommandConfig | false]> = [
    ["typecheck", config.gates.typecheck],
    ["test", config.gates.test],
    ["build", config.gates.build],
  ];

  for (const [name, cfg] of commandGates) {
    if (cfg === false) continue;
    if (!cfg.baselineRelative) continue;
    const evalResult = await evaluateCommand(cfg.command, cwd, cfg.timeoutMs);
    snapshot.passed[name] = evalResult.passed;
    snapshot.failureCounts[name] = evalResult.failureCount;
    snapshot.failures[name] = evalResult.failures;
  }

  return snapshot;
}
