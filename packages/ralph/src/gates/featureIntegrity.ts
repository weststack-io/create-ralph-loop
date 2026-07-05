import type { Gate, GateContext, GateResult } from "./types";

/**
 * The harness owns features.json (the source of truth for feature state).
 * Agents must never edit it; this gate fails the iteration if its hash changed
 * during the coding turn.
 */
export class FeatureIntegrityGate implements Gate {
  readonly name = "featureIntegrity";

  async run(ctx: GateContext): Promise<GateResult> {
    const passed = ctx.featuresHashBefore === ctx.featuresHashAfter;
    if (passed) {
      return {
        gate: this.name,
        passed: true,
        newFailures: [],
        detail: "features.json unchanged",
      };
    }
    return {
      gate: this.name,
      passed: false,
      newFailures: ["features.json modified"],
      detail:
        "features.json was modified during the coding turn — the harness owns this file; agents must not edit it.",
    };
  }
}
