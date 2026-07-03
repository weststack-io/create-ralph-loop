import { z } from "zod";

/**
 * Structured block parsing for the loop's machine-readable agent handoffs.
 *
 * Agents end their output with a single tagged JSON block that the harness
 * consumes. Parsing is FAIL-CLOSED: any malformed / missing / schema-invalid
 * block yields `{ ok: false }` rather than throwing, so a chatty or broken
 * agent can never crash the orchestrator or be mistaken for a success.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Emitted by the coder agent at the end of an implementation attempt. */
export const RalphResultSchema = z.object({
  feature: z.string(),
  outcome: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().default(""),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type RalphResult = z.infer<typeof RalphResultSchema>;

/** Emitted by the fresh-context verifier agent after re-checking the work. */
export const RalphVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  steps: z
    .array(
      z.object({
        step: z.string(),
        ok: z.boolean(),
        evidence: z.string().optional(),
      })
    )
    .default([]),
  concerns: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type RalphVerdict = z.infer<typeof RalphVerdictSchema>;

/** Emitted by the periodic replanner to mutate the plan (via the harness). */
export const RalphPlanUpdateSchema = z.object({
  operations: z
    .array(
      z
        .object({
          op: z.enum([
            "reprioritize",
            "block",
            "unblock",
            "split",
            "prune",
            "add_dependency",
          ]),
          featureId: z.string().optional(),
          priority: z.number().optional(),
          reason: z.string().optional(),
          dependsOn: z.string().optional(),
          newFeatures: z.array(z.any()).optional(),
        })
        .passthrough()
    )
    .default([]),
  summary: z.string().optional(),
});
export type RalphPlanUpdate = z.infer<typeof RalphPlanUpdateSchema>;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the inner content of the LAST `<tag> ... </tag>` occurrence in `text`.
 *
 * Agents may restate a block several times (e.g. once in reasoning, once at the
 * end); the last one wins. Surrounding markdown / whitespace is tolerated. The
 * tag match is case-sensitive. Returns null when the tag is absent.
 */
export function extractBlock(text: string, tag: string): string | null {
  if (!text) return null;
  const open = escapeRegExp(tag);
  // Non-greedy body, case-sensitive, dot matches newlines.
  const re = new RegExp(`<${open}>([\\s\\S]*?)<\\/${open}>`, "g");
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last === null ? null : last.trim();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Strip an optional ```json ... ``` (or bare ``` ... ```) fence and surrounding
 * whitespace, leaving the raw JSON payload.
 */
function stripFences(raw: string): string {
  let s = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(s);
  if (m) s = m[1].trim();
  return s;
}

function parseBlock<S extends z.ZodTypeAny>(
  text: string,
  tag: string,
  schema: S
): ParseOutcome<z.infer<S>> {
  const inner = extractBlock(text, tag);
  if (inner === null) {
    return { ok: false, error: `missing <${tag}> block` };
  }
  const payload = stripFences(inner);
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid JSON in <${tag}>: ${detail}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return {
      ok: false,
      error: `schema validation failed for <${tag}>${where}: ${
        first?.message ?? "unknown error"
      }`,
    };
  }
  return { ok: true, value: parsed.data };
}

export function parseRalphResult(text: string): ParseOutcome<RalphResult> {
  return parseBlock(text, "ralph-result", RalphResultSchema);
}

export function parseRalphVerdict(text: string): ParseOutcome<RalphVerdict> {
  return parseBlock(text, "ralph-verdict", RalphVerdictSchema);
}

export function parseRalphPlanUpdate(text: string): ParseOutcome<RalphPlanUpdate> {
  return parseBlock(text, "ralph-plan-update", RalphPlanUpdateSchema);
}
