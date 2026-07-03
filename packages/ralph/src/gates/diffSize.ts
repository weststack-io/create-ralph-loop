import type { DiffGateConfig } from "../config/schema";
import type { Gate, GateContext, GateResult } from "./types";

/**
 * Bounds the size of a single iteration's diff so a runaway turn can't rewrite
 * the world. Purely reads the diff stat the loop precomputed — never calls git.
 */
export class DiffSizeGate implements Gate {
  readonly name = "diff";
  private readonly cfg: DiffGateConfig;

  constructor(cfg: DiffGateConfig) {
    this.cfg = cfg;
  }

  async run(ctx: GateContext): Promise<GateResult> {
    const { files, insertions, deletions } = ctx.diffStat;
    const lines = insertions + deletions;
    const passed = files <= this.cfg.maxFiles && lines <= this.cfg.maxLines;
    const detail = `diff: ${files} file${files === 1 ? "" : "s"} (limit ${
      this.cfg.maxFiles
    }), ${lines} line${lines === 1 ? "" : "s"} changed (limit ${this.cfg.maxLines})`;
    return {
      gate: this.name,
      passed,
      newFailures: passed ? [] : [detail],
      detail,
    };
  }
}
