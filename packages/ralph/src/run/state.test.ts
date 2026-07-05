import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStateStore } from "./state";

describe("RunStateStore", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-state-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when no state exists", () => {
    expect(new RunStateStore(cwd).load()).toBeNull();
  });

  it("init then load roundtrips", () => {
    const store = new RunStateStore(cwd);
    const created = store.init("run-1", 5);

    expect(created.runId).toBe("run-1");
    expect(created.iteration).toBe(0);
    expect(created.perRole).toEqual({});
    expect(created.features).toEqual({ verified: 0, passed: 0, blocked: 0, total: 5 });
    expect(created.lastProgressIteration).toBe(0);
    expect(created.done).toBe(false);

    const loaded = store.load();
    expect(loaded).toEqual(created);
  });

  it("addUsage accumulates across two calls and updates totals", () => {
    const store = new RunStateStore(cwd);
    const state = store.init("run-1", 3);

    store.addUsage(state, "coder", { inputTokens: 100, outputTokens: 50, costUsd: 0.1 }, 1000);
    store.addUsage(state, "coder", { inputTokens: 20, outputTokens: 5, costUsd: 0.02 }, 500);

    expect(state.perRole.coder).toEqual({
      invocations: 2,
      inputTokens: 120,
      outputTokens: 55,
      costUsd: expect.closeTo(0.12, 5),
      durationMs: 1500,
    });
    expect(state.totalInputTokens).toBe(120);
    expect(state.totalOutputTokens).toBe(55);
    expect(state.totalCostUsd).toBeCloseTo(0.12, 5);

    // Persisted state reflects the accumulation.
    const loaded = store.load()!;
    expect(loaded.perRole.coder.invocations).toBe(2);
    expect(loaded.totalInputTokens).toBe(120);
  });

  it("addUsage treats undefined usage fields as zero", () => {
    const store = new RunStateStore(cwd);
    const state = store.init("run-1", 1);

    store.addUsage(state, "verifier", undefined, 250);
    store.addUsage(state, "verifier", { costUsd: 0.05 }, 250);

    expect(state.perRole.verifier).toEqual({
      invocations: 2,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.05,
      durationMs: 500,
    });
    expect(state.totalCostUsd).toBeCloseTo(0.05, 5);
  });

  it("save/load preserves fields including optionals", () => {
    const store = new RunStateStore(cwd);
    const state = store.init("run-1", 2);
    state.iteration = 4;
    state.features = { verified: 1, passed: 1, blocked: 0, total: 2 };
    state.lastProgressIteration = 3;
    state.checkpointSha = "abc123";
    state.baselineFailureCounts = { "npx tsc": 2 };
    state.done = true;
    state.haltReason = "budget";
    store.save(state);

    const loaded = store.load()!;
    expect(loaded.iteration).toBe(4);
    expect(loaded.features).toEqual({ verified: 1, passed: 1, blocked: 0, total: 2 });
    expect(loaded.lastProgressIteration).toBe(3);
    expect(loaded.checkpointSha).toBe("abc123");
    expect(loaded.baselineFailureCounts).toEqual({ "npx tsc": 2 });
    expect(loaded.done).toBe(true);
    expect(loaded.haltReason).toBe("budget");
    expect(loaded.updatedAt).toBeTruthy();
  });
});
