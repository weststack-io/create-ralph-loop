import { z } from "zod";
import type { PermissionTier, Role } from "../adapters/types";

/**
 * Schema for ralph.config.json — the single infrastructure file in a scaffolded
 * project. Every field has a sensible default so a minimal (even empty) config
 * resolves to a working setup. Role adapters/models encode the shipped default:
 * Fable for planning, Codex for building, Haiku for cheap fail-closed verify.
 */

const PermissionTierSchema = z.enum(["readonly", "edit", "full"]);

const RoleConfigSchema = z.object({
  adapter: z.string(),
  model: z.string().optional(),
  permissionTier: PermissionTierSchema.optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/** Shipped default routing. See AskUserQuestion decision: Fable/Codex/Haiku. */
export const DEFAULT_ROLES: Record<Role, RoleConfig> = {
  coder: { adapter: "codex", permissionTier: "full" },
  verifier: { adapter: "claude", model: "claude-haiku-4-5-20251001", permissionTier: "readonly" },
  planner: { adapter: "claude", model: "claude-fable-5", permissionTier: "edit" },
  replanner: { adapter: "claude", model: "claude-fable-5", permissionTier: "readonly" },
  gardener: { adapter: "claude", model: "claude-haiku-4-5-20251001", permissionTier: "full" },
};

const DEFAULT_PERMISSION_BY_ROLE: Record<Role, PermissionTier> = {
  coder: "full",
  verifier: "readonly",
  planner: "edit",
  replanner: "readonly",
  gardener: "full",
};

const RolesSchema = z
  .object({
    coder: RoleConfigSchema.optional(),
    verifier: RoleConfigSchema.optional(),
    planner: RoleConfigSchema.optional(),
    replanner: RoleConfigSchema.optional(),
    gardener: RoleConfigSchema.optional(),
  })
  .default({});

const GateCommandSchema = z.object({
  command: z.string(),
  /** When true, a failure only blocks if it introduces NEW failures vs baseline. */
  baselineRelative: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(600_000),
});
export type GateCommandConfig = z.infer<typeof GateCommandSchema>;

const DiffGateSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxLines: z.number().int().positive(),
});
export type DiffGateConfig = z.infer<typeof DiffGateSchema>;

/** A gate set to `false` is disabled. */
const GatesSchema = z
  .object({
    typecheck: z
      .union([GateCommandSchema, z.literal(false)])
      .default({ command: "npx tsc --noEmit", baselineRelative: false, timeoutMs: 600_000 }),
    test: z
      .union([GateCommandSchema, z.literal(false)])
      .default({ command: "npm test", baselineRelative: true, timeoutMs: 600_000 }),
    build: z.union([GateCommandSchema, z.literal(false)]).default(false),
    diff: z.union([DiffGateSchema, z.literal(false)]).default({ maxFiles: 40, maxLines: 3000 }),
  })
  .default({});

const RetriesSchema = z
  .object({ maxAttempts: z.number().int().min(0).default(2) })
  .default({ maxAttempts: 2 });

const BudgetsSchema = z
  .object({
    maxCostUsd: z.number().positive().optional(),
    maxIterations: z.number().int().positive().optional(),
    maxWallClockMinutes: z.number().positive().optional(),
  })
  .default({});

const ReplanSchema = z
  .object({ everyIterations: z.number().int().positive().optional() })
  .default({});

/** Periodic "gardening" agent (entropy/slop cleanup). Disabled unless set. */
const GardenSchema = z
  .object({ everyIterations: z.number().int().positive().optional() })
  .default({});

const StallSchema = z
  .object({ noProgressIterations: z.number().int().positive().default(4) })
  .default({ noProgressIterations: 4 });

const VerifySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Dependencies unlock when a feature reaches this status. */
    unlockOn: z.enum(["verified", "passed"]).default("verified"),
  })
  .default({ enabled: true, unlockOn: "verified" });

const DevServerSchema = z
  .object({
    enabled: z.boolean().default(true),
    installCommand: z.string().optional(),
    command: z.string().default("npm run dev"),
    port: z.number().int().positive().default(3000),
    readinessPath: z.string().default("/"),
    readyTimeoutMs: z.number().int().positive().default(120_000),
    env: z.record(z.string()).default({}),
    /** Reserved for parallel tracks: per-track ports allocated from this range. */
    portRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  })
  .default({
    enabled: true,
    command: "npm run dev",
    port: 3000,
    readinessPath: "/",
    readyTimeoutMs: 120_000,
    env: {},
  });
export type DevServerConfig = z.infer<typeof DevServerSchema>;

const NotificationSinkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("desktop"), events: z.array(z.string()).optional() }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    events: z.array(z.string()).optional(),
  }),
]);
export type NotificationSinkConfig = z.infer<typeof NotificationSinkSchema>;

export const RalphConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(2).default(2),
  specDir: z.string().default("specs/phase1"),
  roles: RolesSchema,
  gates: GatesSchema,
  retries: RetriesSchema,
  budgets: BudgetsSchema,
  replan: ReplanSchema,
  garden: GardenSchema,
  stall: StallSchema,
  verify: VerifySchema,
  devServer: DevServerSchema,
  notifications: z.array(NotificationSinkSchema).default([]),
});

export type RalphConfig = z.infer<typeof RalphConfigSchema>;

export interface ResolvedRole {
  adapter: string;
  model?: string;
  permissionTier: PermissionTier;
}

/** Resolve a role's adapter/model/permission, falling back to shipped defaults. */
export function resolveRole(config: RalphConfig, role: Role): ResolvedRole {
  const provided = config.roles?.[role];
  const fallback = DEFAULT_ROLES[role];
  const adapter = provided?.adapter ?? fallback?.adapter;
  if (!adapter) throw new Error(`No adapter configured for role "${role}"`);
  return {
    adapter,
    model: provided?.model ?? fallback?.model,
    permissionTier:
      provided?.permissionTier ?? fallback?.permissionTier ?? DEFAULT_PERMISSION_BY_ROLE[role],
  };
}

/** Parse + validate raw config (throws ZodError on invalid input). */
export function parseConfig(raw: unknown): RalphConfig {
  return RalphConfigSchema.parse(raw);
}

/** A fully-resolved default config (used by tests and `ralph doctor`). */
export function defaultConfig(): RalphConfig {
  return RalphConfigSchema.parse({});
}
