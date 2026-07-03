import { Feature, FeatureFile, isDoneStatus } from "./schema";

export interface DagValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation of the feature DAG: duplicate ids, dangling
 * dependencies, and cycles. Returns *all* problems found (not fail-fast) so a
 * single validate() surfaces everything wrong with the file.
 */
export function validateDag(file: FeatureFile): DagValidation {
  const errors: string[] = [];
  const features = file.features;

  // Duplicate ids.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const f of features) {
    if (seen.has(f.id)) duplicates.add(f.id);
    seen.add(f.id);
  }
  for (const id of duplicates) {
    errors.push(`Duplicate feature id: "${id}"`);
  }

  // Known id set (deduplicated) for dependency resolution.
  const ids = new Set(features.map((f) => f.id));

  // Unknown dependencies.
  for (const f of features) {
    for (const dep of f.depends_on) {
      if (!ids.has(dep)) {
        errors.push(`Feature "${f.id}" depends on unknown id "${dep}"`);
      }
    }
  }

  // Cycle detection via DFS over a first-wins adjacency map (ignores unknown
  // deps, already reported above).
  const adjacency = new Map<string, string[]>();
  for (const f of features) {
    if (!adjacency.has(f.id)) {
      adjacency.set(f.id, f.depends_on.filter((d) => ids.has(d)));
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const reportedCycles = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of adjacency.get(id) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // Found a back-edge -> cycle. Extract the cycle slice from the stack.
        const start = stack.indexOf(dep);
        const cycle = stack.slice(start).concat(dep);
        const key = canonicalCycleKey(cycle);
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}`);
        }
      } else if (c === WHITE) {
        visit(dep, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of adjacency.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
  }

  return { ok: errors.length === 0, errors };
}

/** Rotation-independent key so the same cycle isn't reported twice. */
function canonicalCycleKey(cycle: string[]): string {
  // Drop the repeated closing node, rotate so the smallest id is first.
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return "";
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }
  const rotated = nodes.slice(minIdx).concat(nodes.slice(0, minIdx));
  return rotated.join("->");
}

function isEligible(
  feature: Feature,
  byId: Map<string, Feature>,
  unlockOn: "verified" | "passed",
): boolean {
  if (feature.status !== "pending") return false;
  for (const dep of feature.depends_on) {
    const depFeature = byId.get(dep);
    if (!depFeature) return false; // unknown dep -> never eligible
    if (!isDoneStatus(depFeature.status, unlockOn)) return false;
  }
  return true;
}

function byIdMap(file: FeatureFile): Map<string, Feature> {
  const map = new Map<string, Feature>();
  for (const f of file.features) {
    if (!map.has(f.id)) map.set(f.id, f); // first-wins on duplicates
  }
  return map;
}

/** Eligible features sorted by priority ascending, then id ascending. */
export function eligibleFeatures(
  file: FeatureFile,
  unlockOn: "verified" | "passed",
): Feature[] {
  const byId = byIdMap(file);
  return file.features
    .filter((f) => isEligible(f, byId, unlockOn))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Lowest-priority eligible pending feature (tiebreak id ascending), or null. */
export function selectNextEligible(
  file: FeatureFile,
  unlockOn: "verified" | "passed",
): Feature | null {
  const eligible = eligibleFeatures(file, unlockOn);
  return eligible.length > 0 ? eligible[0] : null;
}

export function summarizeRemaining(
  file: FeatureFile,
  unlockOn: "verified" | "passed",
): { eligible: number; pendingBlocked: number; inProgress: number; done: number } {
  const byId = byIdMap(file);
  let eligible = 0;
  let pendingBlocked = 0;
  let inProgress = 0;
  let done = 0;

  for (const f of file.features) {
    if (isDoneStatus(f.status, unlockOn)) {
      done++;
    } else if (f.status === "in_progress") {
      inProgress++;
    } else if (f.status === "blocked") {
      pendingBlocked++;
    } else if (f.status === "pending") {
      if (isEligible(f, byId, unlockOn)) eligible++;
      else pendingBlocked++;
    }
    // Note: "passed" when unlockOn === "verified" is neither done nor any of
    // the above buckets; it is intentionally uncounted as remaining-work here.
  }

  return { eligible, pendingBlocked, inProgress, done };
}
