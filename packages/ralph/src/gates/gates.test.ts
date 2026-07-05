import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultConfig, parseConfig } from "../config/schema";
import { emptyBaseline } from "./types";
import type { GateContext } from "./types";
import * as baseline from "./baseline";
import { parseFailures, evaluateCommand } from "./baseline";
import { CommandGate, setDiff } from "./command";
import { DiffSizeGate } from "./diffSize";
import { FeatureIntegrityGate } from "./featureIntegrity";
import { buildGates } from "./index";

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  const config = defaultConfig();
  return {
    cwd: process.cwd(),
    config,
    featuresRelPath: "features.json",
    changedFiles: [],
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    featuresHashBefore: "h",
    featuresHashAfter: "h",
    baseline: emptyBaseline(),
    ...overrides,
  };
}

describe("parseFailures", () => {
  it("extracts unique tsc error signatures", () => {
    const out = [
      "src/a.ts(1,2): error TS2304: Cannot find name 'foo'.",
      "src/b.ts(3,4): error TS2345: Argument of type X.",
      "Found 2 errors.",
    ].join("\n");
    expect(parseFailures("npx tsc --noEmit", out)).toEqual([
      "src/a.ts(1,2): error TS2304: Cannot find name 'foo'.",
      "src/b.ts(3,4): error TS2345: Argument of type X.",
    ]);
  });

  it("dedupes identical tsc error lines", () => {
    const line = "src/a.ts(1,2): error TS2304: Cannot find name 'foo'.";
    expect(parseFailures("tsc", `${line}\n${line}`)).toEqual([line]);
  });

  it("captures failing vitest test titles", () => {
    const out = ["✓ passes ok", "× adds numbers", "× subtracts numbers"].join("\n");
    expect(parseFailures("vitest run", out)).toEqual(["adds numbers", "subtracts numbers"]);
  });

  it("synthesizes generic signatures from a summary count when titles missing", () => {
    const out = "Tests: 1 failed, 3 passed, 4 total";
    expect(parseFailures("npm test", out)).toEqual(["test-failure-1"]);
  });

  it("synthesizes N signatures from a bare 'N failed' summary", () => {
    const out = "Some noise\n2 failed\nmore noise";
    // "Tests:" not present + command is npm test -> not a runner unless summary present.
    expect(parseFailures("vitest", out)).toEqual(["test-failure-1", "test-failure-2"]);
  });

  it("returns [] for empty/passing output", () => {
    expect(parseFailures("npm test", "")).toEqual([]);
    expect(parseFailures("tsc", "")).toEqual([]);
  });

  it("falls back to a generic signature for unknown non-empty output", () => {
    expect(parseFailures("make check", "boom something broke")).toEqual([
      "make check exited non-zero",
    ]);
  });
});

describe("setDiff", () => {
  it("returns elements of a not in b, deduped and order-preserving", () => {
    expect(setDiff(["A", "B", "B", "C"], ["A"])).toEqual(["B", "C"]);
    expect(setDiff(["A"], ["A", "B"])).toEqual([]);
  });
});

describe("evaluateCommand", () => {
  it("reports passed for exit 0", async () => {
    const res = await evaluateCommand(`node -e "process.exit(0)"`, process.cwd(), 30_000);
    expect(res.passed).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.failureCount).toBe(0);
  });

  it("reports a fallback failure signature for a non-tsc/non-runner command", async () => {
    // Exit 2 (not 1) to sidestep the cross-spawn Windows shell quirk that
    // misreports an exit code of 1 as ENOENT. Any non-zero code exercises the
    // same failure path.
    const res = await evaluateCommand(
      `node -e "console.error('boom'); process.exit(2)"`,
      process.cwd(),
      30_000,
    );
    expect(res.passed).toBe(false);
    expect(res.failureCount).toBe(1);
    expect(res.failures[0]).toContain("exited non-zero");
  });
});

describe("CommandGate (baseline-relative)", () => {
  afterEach(() => vi.restoreAllMocks());
  const cfg = { command: "noop", baselineRelative: true, timeoutMs: 1000 };

  it("blocks only newly-introduced failures", async () => {
    vi.spyOn(baseline, "evaluateCommand").mockResolvedValue({
      passed: false,
      failureCount: 2,
      failures: ["A", "B"],
    });
    const gate = new CommandGate("test", cfg);
    const result = await gate.run(
      ctx({ baseline: { passed: {}, failureCounts: {}, failures: { test: ["A"] } } }),
    );
    expect(result.newFailures).toEqual(["B"]);
    expect(result.passed).toBe(false);
  });

  it("tolerates pre-existing failures", async () => {
    vi.spyOn(baseline, "evaluateCommand").mockResolvedValue({
      passed: false,
      failureCount: 1,
      failures: ["A"],
    });
    const gate = new CommandGate("test", cfg);
    const result = await gate.run(
      ctx({ baseline: { passed: {}, failureCounts: {}, failures: { test: ["A"] } } }),
    );
    expect(result.newFailures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe("CommandGate (non-baseline)", () => {
  it("passes on exit 0", async () => {
    const gate = new CommandGate("typecheck", {
      command: `node -e "process.exit(0)"`,
      baselineRelative: false,
      timeoutMs: 30_000,
    });
    const r = await gate.run(ctx());
    expect(r.passed).toBe(true);
    expect(r.newFailures).toEqual([]);
  });

  it("blocks on any failure", async () => {
    const gate = new CommandGate("typecheck", {
      command: `node -e "process.exit(2)"`,
      baselineRelative: false,
      timeoutMs: 30_000,
    });
    const r = await gate.run(ctx());
    expect(r.passed).toBe(false);
    expect(r.newFailures?.length).toBe(1);
    expect(r.newFailures?.[0]).toContain("exited non-zero");
  });
});

describe("DiffSizeGate", () => {
  const gate = new DiffSizeGate({ maxFiles: 5, maxLines: 100 });

  it("passes under thresholds", async () => {
    const r = await gate.run(ctx({ diffStat: { files: 3, insertions: 40, deletions: 20 } }));
    expect(r.passed).toBe(true);
  });

  it("fails over file threshold", async () => {
    const r = await gate.run(ctx({ diffStat: { files: 6, insertions: 1, deletions: 0 } }));
    expect(r.passed).toBe(false);
  });

  it("fails over line threshold", async () => {
    const r = await gate.run(ctx({ diffStat: { files: 1, insertions: 90, deletions: 20 } }));
    expect(r.passed).toBe(false);
  });
});

describe("FeatureIntegrityGate", () => {
  const gate = new FeatureIntegrityGate();

  it("passes when hashes match", async () => {
    const r = await gate.run(ctx({ featuresHashBefore: "x", featuresHashAfter: "x" }));
    expect(r.passed).toBe(true);
  });

  it("fails when hashes differ", async () => {
    const r = await gate.run(ctx({ featuresHashBefore: "x", featuresHashAfter: "y" }));
    expect(r.passed).toBe(false);
    expect(r.newFailures).toEqual(["features.json modified"]);
  });
});

describe("buildGates", () => {
  it("includes integrity + defaults in order", () => {
    const gates = buildGates(defaultConfig());
    expect(gates.map((g) => g.name)).toEqual(["featureIntegrity", "diff", "typecheck", "test"]);
  });

  it("omits disabled gates but always keeps integrity", () => {
    const config = parseConfig({ gates: { diff: false, typecheck: false, test: false } });
    const gates = buildGates(config);
    expect(gates.map((g) => g.name)).toEqual(["featureIntegrity"]);
  });

  it("includes build when enabled", () => {
    const config = parseConfig({
      gates: { build: { command: "npm run build" } },
    });
    expect(buildGates(config).map((g) => g.name)).toContain("build");
  });
});
