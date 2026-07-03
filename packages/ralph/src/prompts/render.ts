import path from "node:path";
import fs from "node:fs";
import { Eta } from "eta";
import type { Feature } from "../features/schema";

/**
 * Prompt rendering: resolve a template (project override or packaged default)
 * and render it with eta. eta exposes the context object as `it` inside the
 * template (e.g. `<%= it.projectName %>`).
 */

export type PromptName =
  | "coding"
  | "verifier"
  | "replanner"
  | "init"
  | "prd"
  | "gardener";

export const PROMPT_NAMES: readonly PromptName[] = [
  "coding",
  "verifier",
  "replanner",
  "init",
  "prd",
  "gardener",
];

// ---------------------------------------------------------------------------
// Typed context interfaces (documentation of what each template may reference)
// ---------------------------------------------------------------------------

export interface CodingPromptContext {
  projectName: string;
  projectDescription?: string;
  devPort: number;
  specDir: string;
  feature: Feature;
  iteration: number;
  attempt: number;
  previousFailure?: {
    gates: string[];
    verifierConcerns: string[];
    detail: string;
  };
  recentProgress?: string;
}

export interface VerifierPromptContext {
  projectName: string;
  devPort: number;
  specDir: string;
  feature: Feature;
  diffSummary: string;
}

export interface ReplannerPromptContext {
  specDir: string;
  featuresJson: string;
  recentEvents: string;
  gitLog: string;
}

/** Shared by the init and prd planning prompts. */
export interface PlanPromptContext {
  projectName: string;
  projectDescription: string;
  specDir: string;
}

export interface GardenerPromptContext {
  projectName: string;
  specDir: string;
  recentProgress?: string;
}

// ---------------------------------------------------------------------------
// Template resolution + render
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  cwd: string;
  specDir: string;
}

export interface ResolvedTemplate {
  path: string;
  source: "override" | "default";
}

/** Directory holding the packaged default templates. Sits at the package root
 * in both the source tree (__dirname = <pkg>/src/prompts) and the built output
 * (__dirname = <pkg>/dist/prompts), because assets/ is one level above each. */
function packagedPromptsDir(): string {
  return path.join(__dirname, "..", "..", "assets", "prompts");
}

/**
 * Resolve the template file for `name`, preferring a project override in
 * `${cwd}/${specDir}/prompts/${name}.eta` (then `.md`) over the packaged
 * default at `assets/prompts/${name}.md`.
 */
export function resolveTemplatePath(
  name: PromptName,
  opts: ResolveOpts
): ResolvedTemplate {
  const overrideDir = path.join(opts.cwd, opts.specDir, "prompts");
  for (const ext of [".eta", ".md"]) {
    const candidate = path.join(overrideDir, `${name}${ext}`);
    if (fs.existsSync(candidate)) {
      return { path: candidate, source: "override" };
    }
  }
  return { path: path.join(packagedPromptsDir(), `${name}.md`), source: "default" };
}

/**
 * Resolve, read and render the prompt named `name` with `context`.
 * Returns the rendered string. Throws if no template can be found (a
 * misconfiguration the caller should surface, not swallow).
 */
export function renderPrompt(
  name: PromptName,
  context: object,
  opts: ResolveOpts
): string {
  const resolved = resolveTemplatePath(name, opts);
  const template = fs.readFileSync(resolved.path, "utf8");
  return new Eta().renderString(template, context);
}
