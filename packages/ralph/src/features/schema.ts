import { z } from "zod";

/**
 * features.json v2 — the machine-readable contract for the loop. The agent
 * never writes this file; the harness owns all transitions (enforced by the
 * featureIntegrity gate). Parallel-ready from day one: depends_on drives DAG
 * selection, and lease fields lie dormant until multi-track execution.
 */

export const FEATURE_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "passed", // coder claim + mechanical gates green
  "verified", // independent verifier confirmed (or grandfathered from v1)
] as const;

export const FeatureStatusSchema = z.enum(FEATURE_STATUSES);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

export const StepResultSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  evidence: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const VerificationRecordSchema = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  verifier: z.object({ adapter: z.string(), model: z.string().optional() }).optional(),
  at: z.string(),
  stepResults: z.array(StepResultSchema).optional(),
  concerns: z.array(z.string()).optional(),
  notes: z.string().optional(),
  /** True when carried over from a v1 feature_list.json without re-verification. */
  migrated: z.boolean().optional(),
});
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const LeaseSchema = z.object({
  owner: z.string(),
  acquired_at: z.string(),
  expires_at: z.string(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const FeatureSchema = z.object({
  id: z.string().min(1),
  category: z.string().default("feature"),
  priority: z.number().int(),
  description: z.string().min(1),
  steps: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  status: FeatureStatusSchema.default("pending"),
  attempts: z.number().int().min(0).default(0),
  blocked_reason: z.string().nullable().default(null),
  verification: VerificationRecordSchema.nullable().default(null),
  lease: LeaseSchema.nullable().default(null),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const FeatureFileSchema = z.object({
  version: z.literal(2),
  features: z.array(FeatureSchema),
});
export type FeatureFile = z.infer<typeof FeatureFileSchema>;

export function parseFeatureFile(raw: unknown): FeatureFile {
  return FeatureFileSchema.parse(raw);
}

/** Statuses that count a feature as "done" for dependency-unlock purposes. */
export function isDoneStatus(status: FeatureStatus, unlockOn: "verified" | "passed"): boolean {
  if (unlockOn === "passed") return status === "passed" || status === "verified";
  return status === "verified";
}
