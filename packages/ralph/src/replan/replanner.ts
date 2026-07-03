import type { RunnerAdapter, AgentUsage } from "../adapters/types";
import type { ResolvedRole } from "../config/schema";
import { FeatureStore } from "../features/store";
import type { FeatureFile, Feature } from "../features/schema";
import { FeatureSchema } from "../features/schema";
import { renderPrompt, type ReplannerPromptContext } from "../prompts/render";
import { parseRalphPlanUpdate, type RalphPlanUpdate } from "../prompts/blocks";

/**
 * Periodic self-improvement: a strong model reviews the plan + recent history
 * and proposes a constrained set of operations (reprioritize / block / unblock /
 * split / prune / add_dependency). The harness validates every operation against
 * the schema and DAG invariants before applying; it never lets the replanner
 * delete or downgrade a verified feature.
 */

export interface ReplanOptions {
  adapter: RunnerAdapter;
  role: ResolvedRole;
  cwd: string;
  specDir: string;
  store: FeatureStore;
  gitLog: string;
  recentEvents: string;
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
}

export interface ReplanResult {
  applied: string[];
  skipped: string[];
  summary?: string;
  usage?: AgentUsage;
  durationMs: number;
}

export async function runReplan(opts: ReplanOptions): Promise<ReplanResult> {
  const current = opts.store.load();
  const context: ReplannerPromptContext = {
    specDir: opts.specDir,
    featuresJson: JSON.stringify(current, null, 2),
    recentEvents: opts.recentEvents,
    gitLog: opts.gitLog,
  };
  const prompt = renderPrompt("replanner", context, { cwd: opts.cwd, specDir: opts.specDir });

  const res = await opts.adapter.invoke({
    prompt,
    cwd: opts.cwd,
    role: "replanner",
    model: opts.role.model,
    permissionTier: "readonly",
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });

  const parsed = parseRalphPlanUpdate(res.rawOutput);
  if (!parsed.ok) {
    return { applied: [], skipped: [], summary: `unparseable plan update: ${parsed.error}`, usage: res.usage, durationMs: res.durationMs };
  }

  const { applied, skipped, next } = applyPlanUpdate(current, parsed.value);
  if (applied.length > 0) {
    try {
      opts.store.replaceAll(next); // re-validates schema + DAG; throws if the result is invalid
    } catch (e) {
      return { applied: [], skipped: [...skipped, `rejected: ${(e as Error).message}`], summary: parsed.value.summary, usage: res.usage, durationMs: res.durationMs };
    }
  }
  return { applied, skipped, summary: parsed.value.summary, usage: res.usage, durationMs: res.durationMs };
}

/** Apply operations to a clone; verified features are protected. */
export function applyPlanUpdate(
  file: FeatureFile,
  update: RalphPlanUpdate,
): { applied: string[]; skipped: string[]; next: FeatureFile } {
  const next: FeatureFile = JSON.parse(JSON.stringify(file));
  const byId = (id?: string) => next.features.find((f) => f.id === id);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const op of update.operations) {
    const target = byId(op.featureId);
    try {
      switch (op.op) {
        case "reprioritize":
          if (target && typeof op.priority === "number") {
            target.priority = op.priority;
            applied.push(`reprioritize ${target.id}→${op.priority}`);
          } else skipped.push(`reprioritize (bad target/priority)`);
          break;
        case "block":
          if (target && target.status !== "verified") {
            target.status = "blocked";
            target.blocked_reason = op.reason ?? "blocked by replanner";
            applied.push(`block ${target.id}`);
          } else skipped.push(`block ${op.featureId} (missing or verified)`);
          break;
        case "unblock":
          if (target && target.status === "blocked") {
            target.status = "pending";
            target.blocked_reason = null;
            target.attempts = 0;
            applied.push(`unblock ${target.id}`);
          } else skipped.push(`unblock ${op.featureId} (not blocked)`);
          break;
        case "add_dependency":
          if (target && op.dependsOn && byId(op.dependsOn) && !target.depends_on.includes(op.dependsOn)) {
            target.depends_on.push(op.dependsOn);
            applied.push(`add_dependency ${target.id}←${op.dependsOn}`);
          } else skipped.push(`add_dependency (bad target/dep)`);
          break;
        case "prune":
          if (target && target.status !== "verified") {
            next.features = next.features.filter((f) => f.id !== target.id);
            applied.push(`prune ${target.id}`);
          } else skipped.push(`prune ${op.featureId} (missing or verified)`);
          break;
        case "split":
          if (Array.isArray(op.newFeatures)) {
            let added = 0;
            for (const raw of op.newFeatures) {
              const parsed = FeatureSchema.safeParse(normalizeNewFeature(raw));
              if (parsed.success && !byId(parsed.data.id)) {
                next.features.push(parsed.data as Feature);
                added++;
              }
            }
            if (added) applied.push(`split +${added}`);
            else skipped.push(`split (no valid new features)`);
          } else skipped.push(`split (no newFeatures)`);
          break;
        default:
          skipped.push(`unknown op ${(op as { op: string }).op}`);
      }
    } catch (e) {
      skipped.push(`${op.op}: ${(e as Error).message}`);
    }
  }

  return { applied, skipped, next };
}

function normalizeNewFeature(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    return { status: "pending", attempts: 0, depends_on: [], steps: [], ...(raw as object) };
  }
  return raw;
}
