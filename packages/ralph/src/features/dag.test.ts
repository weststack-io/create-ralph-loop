import { describe, it, expect } from "vitest";
import { FeatureFile, Feature } from "./schema";
import {
  validateDag,
  selectNextEligible,
  eligibleFeatures,
  summarizeRemaining,
} from "./dag";

function feat(partial: Partial<Feature> & { id: string }): Feature {
  return {
    id: partial.id,
    category: partial.category ?? "feature",
    priority: partial.priority ?? 0,
    description: partial.description ?? `desc ${partial.id}`,
    steps: partial.steps ?? [],
    depends_on: partial.depends_on ?? [],
    status: partial.status ?? "pending",
    attempts: partial.attempts ?? 0,
    blocked_reason: partial.blocked_reason ?? null,
    verification: partial.verification ?? null,
    lease: partial.lease ?? null,
  };
}

function file(features: Feature[]): FeatureFile {
  return { version: 2, features };
}

describe("validateDag", () => {
  it("accepts a clean graph", () => {
    const f = file([
      feat({ id: "a" }),
      feat({ id: "b", depends_on: ["a"] }),
      feat({ id: "c", depends_on: ["a", "b"] }),
    ]);
    expect(validateDag(f)).toEqual({ ok: true, errors: [] });
  });

  it("flags duplicate ids", () => {
    const f = file([feat({ id: "a" }), feat({ id: "a" })]);
    const res = validateDag(f);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  it("flags unknown dependencies", () => {
    const f = file([feat({ id: "a", depends_on: ["ghost"] })]);
    const res = validateDag(f);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("detects a cycle A->B->A", () => {
    const f = file([
      feat({ id: "a", depends_on: ["b"] }),
      feat({ id: "b", depends_on: ["a"] }),
    ]);
    const res = validateDag(f);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("detects a longer cycle A->B->C->A", () => {
    const f = file([
      feat({ id: "a", depends_on: ["c"] }),
      feat({ id: "b", depends_on: ["a"] }),
      feat({ id: "c", depends_on: ["b"] }),
    ]);
    const res = validateDag(f);
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.toLowerCase().includes("cycle")).length).toBe(1);
  });
});

describe("selectNextEligible / eligibleFeatures", () => {
  it("does not select a pending feature whose dep is still pending", () => {
    const f = file([
      feat({ id: "dep", status: "pending" }),
      feat({ id: "x", depends_on: ["dep"] }),
    ]);
    expect(selectNextEligible(f, "verified")).not.toBeNull();
    // The only selectable one is "dep" (no deps); "x" is blocked by dep.
    expect(selectNextEligible(f, "verified")!.id).toBe("dep");
  });

  it("selects a feature once its dep becomes verified", () => {
    const f = file([
      feat({ id: "dep", status: "verified" }),
      feat({ id: "x", depends_on: ["dep"] }),
    ]);
    expect(selectNextEligible(f, "verified")!.id).toBe("x");
  });

  it("lowest priority wins, id tiebreak", () => {
    const f = file([
      feat({ id: "b", priority: 5 }),
      feat({ id: "a", priority: 5 }),
      feat({ id: "c", priority: 1 }),
    ]);
    expect(selectNextEligible(f, "verified")!.id).toBe("c");
    const ids = eligibleFeatures(f, "verified").map((x) => x.id);
    expect(ids).toEqual(["c", "a", "b"]);
  });

  it("unlockOn:passed lets a passed dep unlock", () => {
    const f = file([
      feat({ id: "dep", status: "passed" }),
      feat({ id: "x", depends_on: ["dep"] }),
    ]);
    // Under "verified": dep is "passed" (not pending, so not selectable) and x
    // is still blocked because dep isn't verified -> nothing eligible.
    expect(selectNextEligible(f, "verified")).toBeNull();
    expect(selectNextEligible(f, "passed")!.id).toBe("x"); // dep now counts done
  });

  it("returns null when nothing is eligible", () => {
    const f = file([feat({ id: "a", status: "verified" })]);
    expect(selectNextEligible(f, "verified")).toBeNull();
  });
});

describe("summarizeRemaining", () => {
  it("buckets features correctly", () => {
    const f = file([
      feat({ id: "done", status: "verified" }),
      feat({ id: "prog", status: "in_progress" }),
      feat({ id: "blk", status: "blocked" }),
      feat({ id: "elig", status: "pending" }),
      feat({ id: "waiting", status: "pending", depends_on: ["elig"] }),
    ]);
    const s = summarizeRemaining(f, "verified");
    expect(s).toEqual({
      eligible: 1, // elig
      pendingBlocked: 2, // blk + waiting
      inProgress: 1,
      done: 1,
    });
  });
});
