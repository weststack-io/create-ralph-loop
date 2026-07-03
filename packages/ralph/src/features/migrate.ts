import fs from "node:fs";
import { z } from "zod";
import { Feature, FeatureFile, FeatureFileSchema } from "./schema";

/** Shape of a legacy v1 feature entry (feature_list.json). */
const V1FeatureSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  priority: z.number().int(),
  category: z.string().optional(),
  description: z.string(),
  steps: z.array(z.string()).optional(),
  passes: z.boolean(),
});

const V1FileSchema = z.union([
  z.object({ features: z.array(V1FeatureSchema) }),
  z.array(V1FeatureSchema),
]);

/**
 * Convert legacy v1 feature data (either `{ features: [...] }` or a bare array)
 * into a v2 FeatureFile. Passing v1 features are grandfathered to "verified"
 * with a `migrated` verification stamp; the rest become fresh "pending".
 */
export function migrateV1(v1raw: unknown): FeatureFile {
  const parsed = V1FileSchema.parse(v1raw);
  const v1features = Array.isArray(parsed) ? parsed : parsed.features;
  const now = new Date().toISOString();

  const features: Feature[] = v1features.map((v1) => ({
    id: v1.id,
    priority: v1.priority,
    category: v1.category ?? "feature",
    description: v1.description,
    steps: v1.steps ?? [],
    depends_on: [],
    status: v1.passes ? "verified" : "pending",
    attempts: 0,
    blocked_reason: null,
    verification: v1.passes
      ? { verdict: "pass", at: now, migrated: true }
      : null,
    lease: null,
  }));

  const file: FeatureFile = { version: 2, features };
  // Round-trip through the canonical schema so malformed v1 data surfaces here.
  return FeatureFileSchema.parse(file);
}

/** Read a v1 JSON file, migrate it, and write the v2 result to destPath. */
export function migrateV1File(srcPath: string, destPath: string): FeatureFile {
  const raw = fs.readFileSync(srcPath, "utf8");
  const file = migrateV1(JSON.parse(raw));
  fs.writeFileSync(destPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  return file;
}
