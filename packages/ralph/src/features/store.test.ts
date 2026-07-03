import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeatureStore } from "./store";
import { FeatureFile } from "./schema";

function sampleFile(): FeatureFile {
  return {
    version: 2,
    features: [
      {
        id: "a",
        category: "feature",
        priority: 1,
        description: "first",
        steps: [],
        depends_on: [],
        status: "pending",
        attempts: 0,
        blocked_reason: null,
        verification: null,
        lease: null,
      },
      {
        id: "b",
        category: "feature",
        priority: 2,
        description: "second",
        steps: [],
        depends_on: ["a"],
        status: "pending",
        attempts: 0,
        blocked_reason: null,
        verification: null,
        lease: null,
      },
    ],
  };
}

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-store-"));
  filePath = path.join(dir, "features.json");
  fs.writeFileSync(filePath, JSON.stringify(sampleFile(), null, 2) + "\n", "utf8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FeatureStore", () => {
  it("loads, gets, and counts", () => {
    const store = new FeatureStore(filePath);
    expect(store.all().length).toBe(2);
    expect(store.get("a")!.description).toBe("first");
    expect(store.get("missing")).toBeUndefined();
    const c = store.counts();
    expect(c.total).toBe(2);
    expect(c.pending).toBe(2);
    expect(c.verified).toBe(0);
  });

  it("transition updates status and persists to disk", () => {
    const store = new FeatureStore(filePath);
    store.transition("a", "verified");
    expect(store.get("a")!.status).toBe("verified");
    // Fresh store reads persisted value.
    const reread = new FeatureStore(filePath);
    expect(reread.get("a")!.status).toBe("verified");
  });

  it("snapshotHash is stable across a save of identical content", () => {
    const store = new FeatureStore(filePath);
    const before = store.snapshotHash();
    store.load();
    store.save(); // identical content
    expect(store.snapshotHash()).toBe(before);
  });

  it("snapshotHash changes when a status flips", () => {
    const store = new FeatureStore(filePath);
    const before = store.snapshotHash();
    store.transition("a", "verified");
    expect(store.snapshotHash()).not.toBe(before);
  });

  it("transition to blocked records reason", () => {
    const store = new FeatureStore(filePath);
    store.transition("b", "blocked", { reason: "dep failed" });
    expect(store.get("b")!.status).toBe("blocked");
    expect(store.get("b")!.blocked_reason).toBe("dep failed");
  });

  it("incrementAttempts and setAttempts work", () => {
    const store = new FeatureStore(filePath);
    store.transition("a", "in_progress", { incrementAttempts: true });
    expect(store.get("a")!.attempts).toBe(1);
    store.transition("a", "in_progress", { incrementAttempts: true });
    expect(store.get("a")!.attempts).toBe(2);
    store.transition("a", "pending", { setAttempts: 0 });
    expect(store.get("a")!.attempts).toBe(0);
  });

  it("records and clears verification", () => {
    const store = new FeatureStore(filePath);
    store.transition("a", "verified", {
      verification: { verdict: "pass", at: "2026-01-01T00:00:00.000Z" },
    });
    expect(store.get("a")!.verification!.verdict).toBe("pass");
    store.transition("a", "pending", { verification: null });
    expect(store.get("a")!.verification).toBeNull();
  });

  it("nextEligible and validate delegate to the dag", () => {
    const store = new FeatureStore(filePath);
    expect(store.nextEligible("verified")!.id).toBe("a");
    expect(store.validate().ok).toBe(true);
  });

  it("throws on transition of unknown id", () => {
    const store = new FeatureStore(filePath);
    expect(() => store.transition("nope", "verified")).toThrow(/not found/i);
  });
});
