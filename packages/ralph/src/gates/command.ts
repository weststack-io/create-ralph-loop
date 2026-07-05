import type { GateCommandConfig } from "../config/schema";
import type { Gate, GateContext, GateResult } from "./types";
import { evaluateCommand } from "./baseline";

/**
 * A command gate runs a configured subprocess (typecheck/test/build) and, when
 * `baselineRelative`, only blocks on failure signatures that did not already
 * exist at baseline — pre-existing failures are tolerated (hermes-agent pattern).
 */
export class CommandGate implements Gate {
  readonly name: string;
  private readonly cfg: GateCommandConfig;

  constructor(name: string, cfg: GateCommandConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async run(ctx: GateContext): Promise<GateResult> {
    const cur = await evaluateCommand(this.cfg.command, ctx.cwd, this.cfg.timeoutMs);

    if (!this.cfg.baselineRelative) {
      const passed = cur.passed;
      const newFailures = passed ? [] : cur.failures;
      const detail = passed
        ? `${this.name}: command exited 0`
        : `${this.name}: command exited non-zero (${cur.failureCount} failure${
            cur.failureCount === 1 ? "" : "s"
          })`;
      return { gate: this.name, passed, newFailures, detail };
    }

    const baseFailures = ctx.baseline.failures[this.name] ?? [];
    const newFailures = setDiff(cur.failures, baseFailures);
    const passed = cur.passed || newFailures.length === 0;
    const detail = passed
      ? `${this.name}: no new failures (${cur.failureCount} current, ${baseFailures.length} at baseline)`
      : `${this.name}: ${newFailures.length} new failure${
          newFailures.length === 1 ? "" : "s"
        } introduced (${cur.failureCount} current, ${baseFailures.length} at baseline)`;

    return { gate: this.name, passed, newFailures, detail };
  }
}

/** Elements of `a` not present in `b` (order-preserving, de-duplicated). */
export function setDiff(a: string[], b: string[]): string[] {
  const bset = new Set(b);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of a) {
    if (!bset.has(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
