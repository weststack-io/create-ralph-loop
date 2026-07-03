import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { defaultConfig, type RalphConfig } from "../packages/ralph/src/config/schema";
import { FeatureStore } from "../packages/ralph/src/features/store";
import { buildGates } from "../packages/ralph/src/gates";
import { MockAdapter } from "../packages/ralph/src/adapters/mock";
import { EventLog } from "../packages/ralph/src/events/log";
import { RunStateStore } from "../packages/ralph/src/run/state";
import { NotificationHub } from "../packages/ralph/src/notify";
import { DevServerManager } from "../packages/ralph/src/devserver/manager";
import { runLoop } from "../packages/ralph/src/run/loop";
import type { RunContext } from "../packages/ralph/src/run/types";
import type { FeatureFile } from "../packages/ralph/src/features/schema";

// --- test scaffolding -------------------------------------------------------

let cwd: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(features: FeatureFile): void {
  fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app", version: "0.0.0" }, null, 2));
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".ralph/\nnode_modules/\n");
  fs.writeFileSync(path.join(cwd, "specs", "features.json"), JSON.stringify(features, null, 2) + "\n");
  git(["init", "-q"]);
  git(["config", "user.email", "test@ralph.dev"]);
  git(["config", "user.name", "Ralph Test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-q", "--no-verify", "-m", "init"]);
}

function commitLog(): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

function baseConfig(overrides: (c: RalphConfig) => void): RalphConfig {
  const c = defaultConfig();
  c.specDir = "specs";
  c.devServer.enabled = false;
  c.verify.enabled = false;
  c.gates.typecheck = false;
  c.gates.test = false;
  c.gates.build = false;
  c.stall.noProgressIterations = 999; // isolate from stall halting unless tested
  overrides(c);
  return c;
}

function noopAdapter(): MockAdapter {
  return new MockAdapter(() => ({ exitCode: 0, rawOutput: "", durationMs: 1, timedOut: false }));
}

function makeContext(
  config: RalphConfig,
  coder: MockAdapter,
  verifier: MockAdapter,
  replanner: MockAdapter = noopAdapter(),
  gardener: MockAdapter = noopAdapter(),
): RunContext {
  const store = new FeatureStore(path.join(cwd, "specs", "features.json"));
  store.load();
  const eventLog = new EventLog(cwd);
  const stateStore = new RunStateStore(cwd);
  const state = stateStore.init("test-run", store.counts().total);
  return {
    cwd,
    config,
    projectName: "fixture-app",
    featuresRelPath: "specs/features.json",
    store,
    devServer: new DevServerManager(cwd, config.devServer),
    eventLog,
    stateStore,
    state,
    gates: buildGates(config),
    notifier: new NotificationHub([]),
    coder: { adapter: coder, role: { adapter: "mock", permissionTier: "full" } },
    verifier: { adapter: verifier, role: { adapter: "mock", model: "mock-verifier", permissionTier: "readonly" } },
    replanner: { adapter: replanner, role: { adapter: "mock", permissionTier: "readonly" } },
    gardener: { adapter: gardener, role: { adapter: "mock", permissionTier: "full" } },
    stream: false,
    agentTimeoutMs: 30_000,
  };
}

function result(outcome: "implemented" | "partial" | "blocked", summary = "did the thing"): string {
  return `<ralph-result>${JSON.stringify({ feature: "x", outcome, summary, blockers: [] })}</ralph-result>`;
}
function verdict(v: "pass" | "fail" | "inconclusive"): string {
  return `<ralph-verdict>${JSON.stringify({ verdict: v, steps: [], concerns: v === "pass" ? [] : ["nope"] })}</ralph-verdict>`;
}

/** Coder that writes a unique source file each call and reports implemented. */
function writingCoder(): MockAdapter {
  return new MockAdapter((req, i) => {
    fs.writeFileSync(path.join(req.cwd, "src", `mod_${i}.ts`), `export const v${i} = ${i};\n`);
    return { exitCode: 0, rawOutput: result("implemented"), durationMs: 1, timedOut: false };
  });
}

function features(list: Array<{ id: string; priority: number; deps?: string[] }>): FeatureFile {
  return {
    version: 2,
    features: list.map((f) => ({
      id: f.id,
      category: "feature",
      priority: f.priority,
      description: `implement ${f.id}`,
      steps: [`build ${f.id}`],
      depends_on: f.deps ?? [],
      status: "pending",
      attempts: 0,
      blocked_reason: null,
      verification: null,
      lease: null,
    })),
  };
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-e2e-"));
});
afterEach(() => {
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --- scenarios --------------------------------------------------------------

describe("runLoop end-to-end (mock adapters, real git)", () => {
  it("happy path: implements and accepts each feature, ends complete", async () => {
    initRepo(features([{ id: "F1", priority: 1 }, { id: "F2", priority: 2 }]));
    const config = baseConfig(() => {});
    const ctx = makeContext(config, writingCoder(), new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    const summary = await runLoop(ctx, { maxIterations: 10 });

    expect(summary.reason).toBe("all features complete");
    expect(summary.passed + summary.verified).toBe(2);
    expect(ctx.store.get("F1")!.status).toBe("passed"); // verify disabled → passed
    const log = commitLog();
    expect(log.filter((m) => m.startsWith("ralph(F1)"))).toHaveLength(1);
    expect(log.filter((m) => m.startsWith("ralph(F2)"))).toHaveLength(1);
  });

  it("independent verifier: pass promotes to verified", async () => {
    initRepo(features([{ id: "F1", priority: 1 }]));
    const config = baseConfig((c) => { c.verify.enabled = true; });
    const ctx = makeContext(config, writingCoder(), new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    await runLoop(ctx, { maxIterations: 10 });
    expect(ctx.store.get("F1")!.status).toBe("verified");
    expect(ctx.store.get("F1")!.verification?.verdict).toBe("pass");
  });

  it("verifier failure reverts and eventually blocks the feature", async () => {
    initRepo(features([{ id: "F1", priority: 1 }]));
    const config = baseConfig((c) => { c.verify.enabled = true; c.retries.maxAttempts = 1; });
    const ctx = makeContext(config, writingCoder(), new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("fail"), durationMs: 1, timedOut: false })));

    const summary = await runLoop(ctx, { maxIterations: 10 });
    expect(ctx.store.get("F1")!.status).toBe("blocked");
    expect(summary.blocked).toBe(1);
    // no accept commit for F1
    expect(commitLog().some((m) => m.startsWith("ralph(F1): verified"))).toBe(false);
  });

  it("failing gate reverts the change; retries then blocks after maxAttempts", async () => {
    initRepo(features([{ id: "F1", priority: 1 }]));
    const config = baseConfig((c) => {
      c.retries.maxAttempts = 2;
      c.gates.typecheck = { command: 'node -e "process.exit(1)"', baselineRelative: false, timeoutMs: 30_000 };
    });
    const ctx = makeContext(config, writingCoder(), new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    const summary = await runLoop(ctx, { maxIterations: 20 });
    expect(ctx.store.get("F1")!.status).toBe("blocked");
    expect(summary.iterations).toBe(3); // attempt 1,2 retry; attempt 3 blocks
    // working tree clean, no orphaned src files from reverted attempts
    expect(fs.existsSync(path.join(cwd, "src", "mod_0.ts"))).toBe(false);
  });

  it("integrity gate: agent editing features.json is reverted", async () => {
    initRepo(features([{ id: "F1", priority: 1 }]));
    const config = baseConfig((c) => { c.retries.maxAttempts = 0; });
    const tamperingCoder = new MockAdapter((req) => {
      fs.writeFileSync(path.join(req.cwd, "src", "ok.ts"), "export const ok = 1;\n");
      const fp = path.join(req.cwd, "specs", "features.json");
      const f = JSON.parse(fs.readFileSync(fp, "utf8"));
      f.features[0].status = "verified"; // illicit self-grade
      fs.writeFileSync(fp, JSON.stringify(f, null, 2) + "\n");
      return { exitCode: 0, rawOutput: result("implemented"), durationMs: 1, timedOut: false };
    });
    const ctx = makeContext(config, tamperingCoder, new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    await runLoop(ctx, { maxIterations: 5 });
    // reverted + blocked (maxAttempts 0), status must NOT be the agent's forged "verified"
    expect(ctx.store.get("F1")!.status).toBe("blocked");
  });

  it("dependency ordering: dependent feature waits for its prerequisite", async () => {
    initRepo(features([{ id: "F1", priority: 2 }, { id: "F2", priority: 1, deps: ["F1"] }]));
    const config = baseConfig((c) => { c.verify.enabled = true; });
    const ctx = makeContext(config, writingCoder(), new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    await runLoop(ctx, { maxIterations: 10 });
    const transitions = ctx.eventLog.read().filter((e) => e.type === "feature_transition").map((e) => (e as { featureId: string }).featureId);
    // F1 must be accepted before F2 even though F2 has the lower priority number
    expect(transitions).toEqual(["F1", "F2"]);
  });

  it("replanner can block a feature mid-run (self-improvement hook)", async () => {
    initRepo(features([{ id: "F1", priority: 1 }, { id: "F2", priority: 2 }]));
    const config = baseConfig((c) => { c.replan.everyIterations = 1; });
    const replanner = new MockAdapter(() => ({
      exitCode: 0,
      rawOutput: `<ralph-plan-update>${JSON.stringify({ operations: [{ op: "block", featureId: "F2", reason: "descoped" }], summary: "drop F2" })}</ralph-plan-update>`,
      durationMs: 1,
      timedOut: false,
    }));
    const ctx = makeContext(config, writingCoder(), noopAdapter(), replanner);

    const summary = await runLoop(ctx, { maxIterations: 10 });
    expect(ctx.store.get("F1")!.status).toBe("passed");
    expect(ctx.store.get("F2")!.status).toBe("blocked");
    expect(summary.iterations).toBe(1); // F1 done, replan blocks F2 → nothing eligible
    const replans = ctx.eventLog.read().filter((e) => e.type === "replan");
    expect(replans.length).toBeGreaterThanOrEqual(1);
  });

  it("agent-reported blocked: reverts and blocks without exhausting retries", async () => {
    initRepo(features([{ id: "F1", priority: 1 }]));
    const config = baseConfig((c) => { c.retries.maxAttempts = 3; });
    const givingUpCoder = new MockAdapter((req) => {
      fs.writeFileSync(path.join(req.cwd, "src", "partial.ts"), "// wip\n");
      return { exitCode: 0, rawOutput: result("blocked", "cannot do this"), durationMs: 1, timedOut: false };
    });
    const ctx = makeContext(config, givingUpCoder, new MockAdapter(() => ({ exitCode: 0, rawOutput: verdict("pass"), durationMs: 1, timedOut: false })));

    const summary = await runLoop(ctx, { maxIterations: 10 });
    expect(ctx.store.get("F1")!.status).toBe("blocked");
    expect(summary.iterations).toBe(1); // no wasted retries on an explicit give-up
  });
});
