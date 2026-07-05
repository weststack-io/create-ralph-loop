import type { RalphConfig } from "../config/schema";
import type { Gate } from "./types";
import { FeatureIntegrityGate } from "./featureIntegrity";
import { DiffSizeGate } from "./diffSize";
import { CommandGate } from "./command";

/**
 * Build the ordered list of mechanical gates for a config. The feature-integrity
 * gate is always present; every other gate can be disabled by setting its config
 * to `false`. Order: featureIntegrity, diff, typecheck, test, build.
 */
export function buildGates(config: RalphConfig): Gate[] {
  const gates: Gate[] = [new FeatureIntegrityGate()];

  if (config.gates.diff !== false) {
    gates.push(new DiffSizeGate(config.gates.diff));
  }

  const commandGates = ["typecheck", "test", "build"] as const;
  for (const name of commandGates) {
    const cfg = config.gates[name];
    if (cfg !== false) gates.push(new CommandGate(name, cfg));
  }

  return gates;
}

export { captureBaseline, evaluateCommand, parseFailures } from "./baseline";
export type { CommandEval } from "./baseline";
export { CommandGate, setDiff } from "./command";
export { DiffSizeGate } from "./diffSize";
export { FeatureIntegrityGate } from "./featureIntegrity";
