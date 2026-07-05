import fs from "node:fs";
import crypto from "node:crypto";
import {
  Feature,
  FeatureFile,
  FeatureStatus,
  FEATURE_STATUSES,
  VerificationRecord,
  parseFeatureFile,
} from "./schema";
import {
  DagValidation,
  selectNextEligible,
  validateDag,
} from "./dag";

export interface TransitionMeta {
  reason?: string;
  verification?: VerificationRecord | null;
  setAttempts?: number;
  incrementAttempts?: boolean;
  lease?: Feature["lease"];
}

/**
 * Read/modify/persist wrapper around a features.json file. The harness owns all
 * transitions; the agent never writes this file. Serialization is deterministic
 * (`JSON.stringify(file, null, 2) + "\n"`) so the featureIntegrity gate can hash
 * the on-disk bytes before/after each turn and detect illicit edits.
 */
export class FeatureStore {
  private readonly absFilePath: string;
  private cache: FeatureFile | null = null;

  constructor(absFilePath: string) {
    this.absFilePath = absFilePath;
  }

  /** Path this store reads/writes. */
  get path(): string {
    return this.absFilePath;
  }

  /** Load from disk if not already cached; otherwise return the cache. */
  load(): FeatureFile {
    if (this.cache === null) return this.reload();
    return this.cache;
  }

  /** Force a fresh read from disk, replacing the cache. */
  reload(): FeatureFile {
    const raw = fs.readFileSync(this.absFilePath, "utf8");
    this.cache = parseFeatureFile(JSON.parse(raw));
    return this.cache;
  }

  private serialize(file: FeatureFile): string {
    return JSON.stringify(file, null, 2) + "\n";
  }

  /** Write the cached file to disk with deterministic formatting. */
  save(): void {
    const file = this.load();
    fs.writeFileSync(this.absFilePath, this.serialize(file), "utf8");
  }

  /** sha256 (hex) of the current on-disk bytes — read fresh, not the cache. */
  snapshotHash(): string {
    const bytes = fs.readFileSync(this.absFilePath);
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }

  get(id: string): Feature | undefined {
    return this.load().features.find((f) => f.id === id);
  }

  /** Like get() but throws if the id is unknown. */
  getRequired(id: string): Feature {
    const feature = this.get(id);
    if (!feature) throw new Error(`Feature not found: "${id}"`);
    return feature;
  }

  all(): Feature[] {
    return this.load().features;
  }

  nextEligible(unlockOn: "verified" | "passed"): Feature | null {
    return selectNextEligible(this.load(), unlockOn);
  }

  validate(): DagValidation {
    return validateDag(this.load());
  }

  /**
   * Mutate a single feature in the cache and persist. Only the fields implied
   * by `meta` are touched; everything else is preserved so serialization stays
   * stable.
   */
  transition(id: string, to: FeatureStatus, meta: TransitionMeta = {}): void {
    const feature = this.getRequired(id);

    feature.status = to;

    if (to === "blocked") {
      feature.blocked_reason = meta.reason ?? feature.blocked_reason;
    }

    if (meta.verification !== undefined) {
      feature.verification = meta.verification;
    }

    if (typeof meta.setAttempts === "number") {
      feature.attempts = meta.setAttempts;
    }
    if (meta.incrementAttempts) {
      feature.attempts += 1;
    }

    if (meta.lease !== undefined) {
      feature.lease = meta.lease;
    }

    this.save();
  }

  /**
   * Replace the entire feature set (used by the replanner). Validates schema +
   * DAG before persisting; throws on invalid input so a bad replan is rejected
   * rather than corrupting the contract.
   */
  replaceAll(file: FeatureFile): void {
    const parsed = parseFeatureFile(file);
    const dag = validateDag(parsed);
    if (!dag.ok) {
      throw new Error(`replan produced an invalid feature DAG: ${dag.errors.join("; ")}`);
    }
    this.cache = parsed;
    this.save();
  }

  /** Count features by status, plus a total. */
  counts(): Record<FeatureStatus, number> & { total: number } {
    const result = {} as Record<FeatureStatus, number> & { total: number };
    for (const status of FEATURE_STATUSES) result[status] = 0;
    result.total = 0;
    for (const f of this.load().features) {
      result[f.status] += 1;
      result.total += 1;
    }
    return result;
  }
}
