import { describe, it, expect } from "vitest";
import { applyPlanUpdate } from "./replanner";
import type { FeatureFile } from "../features/schema";

function file(): FeatureFile {
  return {
    version: 2,
    features: [
      { id: "A", category: "feature", priority: 1, description: "a", steps: [], depends_on: [], status: "verified", attempts: 0, blocked_reason: null, verification: null, lease: null },
      { id: "B", category: "feature", priority: 2, description: "b", steps: [], depends_on: [], status: "pending", attempts: 3, blocked_reason: null, verification: null, lease: null },
      { id: "C", category: "feature", priority: 3, description: "c", steps: [], depends_on: [], status: "blocked", attempts: 2, blocked_reason: "x", verification: null, lease: null },
    ],
  };
}

describe("applyPlanUpdate", () => {
  it("reprioritizes a feature", () => {
    const { applied, next } = applyPlanUpdate(file(), { operations: [{ op: "reprioritize", featureId: "B", priority: 9 }] });
    expect(applied).toContain("reprioritize B→9");
    expect(next.features.find((f) => f.id === "B")!.priority).toBe(9);
  });

  it("blocks a pending feature but never a verified one", () => {
    const { applied, skipped, next } = applyPlanUpdate(file(), {
      operations: [
        { op: "block", featureId: "B", reason: "descoped" },
        { op: "block", featureId: "A", reason: "should be ignored" },
      ],
    });
    expect(next.features.find((f) => f.id === "B")!.status).toBe("blocked");
    expect(next.features.find((f) => f.id === "A")!.status).toBe("verified");
    expect(applied).toContain("block B");
    expect(skipped.join()).toMatch(/block A/);
  });

  it("unblocks and resets attempts", () => {
    const { next } = applyPlanUpdate(file(), { operations: [{ op: "unblock", featureId: "C" }] });
    const c = next.features.find((f) => f.id === "C")!;
    expect(c.status).toBe("pending");
    expect(c.attempts).toBe(0);
    expect(c.blocked_reason).toBeNull();
  });

  it("adds a dependency (existing target only)", () => {
    const { next } = applyPlanUpdate(file(), { operations: [{ op: "add_dependency", featureId: "B", dependsOn: "A" }] });
    expect(next.features.find((f) => f.id === "B")!.depends_on).toContain("A");
  });

  it("prunes non-verified features but protects verified", () => {
    const { next, applied, skipped } = applyPlanUpdate(file(), {
      operations: [
        { op: "prune", featureId: "C" },
        { op: "prune", featureId: "A" },
      ],
    });
    expect(next.features.some((f) => f.id === "C")).toBe(false);
    expect(next.features.some((f) => f.id === "A")).toBe(true);
    expect(applied).toContain("prune C");
    expect(skipped.join()).toMatch(/prune A/);
  });

  it("splits in new valid features and rejects invalid ones", () => {
    const { next, applied } = applyPlanUpdate(file(), {
      operations: [
        { op: "split", newFeatures: [{ id: "D", priority: 5, description: "new" }, { id: "bad" /* no desc/priority */ }] },
      ],
    });
    expect(next.features.some((f) => f.id === "D")).toBe(true);
    expect(next.features.some((f) => f.id === "bad")).toBe(false);
    expect(applied).toContain("split +1");
  });
});
