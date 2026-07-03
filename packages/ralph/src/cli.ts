#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { loadConfig, findConfig } from "./config/load";
import { resolveRole } from "./config/schema";
import { FeatureStore } from "./features/store";
import { migrateV1File } from "./features/migrate";
import { buildGates } from "./gates";
import { getAdapter, probeAvailability } from "./adapters/registry";
import { DevServerManager } from "./devserver/manager";
import { EventLog } from "./events/log";
import { RunStateStore } from "./run/state";
import { NotificationHub } from "./notify";
import { runLoop } from "./run/loop";
import type { RunContext } from "./run/types";
import { commandExists } from "./util/proc";
import { isRepo } from "./util/git";
import { featuresPath, configPath, legacyDir, CONFIG_FILENAME } from "./util/paths";
import { defaultConfig } from "./config/schema";
import { log, color } from "./util/logger";
import { VERSION } from "./index";

const program = new Command();
program
  .name("ralph")
  .description("Autonomous software-building harness — the Ralph loop, codified.")
  .version(VERSION);

// --------------------------------------------------------------------------
// ralph run
// --------------------------------------------------------------------------
program
  .command("run")
  .description("Run the autonomous build loop until complete, budget, or stall.")
  .option("-n, --iterations <n>", "max iterations (overrides config budget)", (v) => parseInt(v, 10))
  .option("-b, --budget <usd>", "max cost in USD (overrides config budget)", (v) => parseFloat(v))
  .option("--no-verify", "skip the independent verifier (faster, less safe)")
  .option("--no-stream", "do not stream agent output to the console")
  .option("--fresh", "clear prior run state and progress log before starting")
  .action(async (opts) => {
    const cwd = process.cwd();
    try {
      await runCommand(cwd, opts);
    } catch (e) {
      log.error((e as Error).message);
      process.exitCode = 1;
    }
  });

async function runCommand(cwd: string, opts: Record<string, unknown>): Promise<void> {
  const config = loadConfig(cwd);
  if (opts.verify === false) config.verify.enabled = false;
  if (typeof opts.budget === "number") config.budgets.maxCostUsd = opts.budget as number;

  if (!(await isRepo(cwd))) {
    throw new Error("ralph run must be executed inside a git repository (run `git init` first).");
  }
  ensureRalphGitignored(cwd);

  const specDir = config.specDir;
  const featuresAbs = featuresPath(cwd, specDir);
  if (!fs.existsSync(featuresAbs)) {
    throw new Error(`No features file at ${featuresAbs}. Generate specs first (create-ralph-loop / ralph plan).`);
  }
  const store = new FeatureStore(featuresAbs);
  store.load();
  const dag = store.validate();
  if (!dag.ok) {
    throw new Error(`features.json is invalid:\n${dag.errors.map((e) => "  - " + e).join("\n")}`);
  }

  const coderRole = resolveRole(config, "coder");
  const verifierRole = resolveRole(config, "verifier");
  const coderAdapter = getAdapter(coderRole.adapter);
  const verifierAdapter = getAdapter(verifierRole.adapter);
  if (!(await coderAdapter.isAvailable())) {
    throw new Error(`coder adapter '${coderRole.adapter}' CLI is not installed or not on PATH.`);
  }
  if (config.verify.enabled && !(await verifierAdapter.isAvailable())) {
    throw new Error(`verifier adapter '${verifierRole.adapter}' CLI is not installed or not on PATH.`);
  }

  const meta = readProjectMeta(cwd);
  const eventLog = new EventLog(cwd);
  if (opts.fresh) eventLog.clear();
  const stateStore = new RunStateStore(cwd);
  let state = stateStore.load();
  if (opts.fresh || !state || state.done) {
    state = stateStore.init(randomUUID(), store.counts().total);
  }

  const devServer = new DevServerManager(cwd, config.devServer);
  const notifier = new NotificationHub(config.notifications);

  const ctx: RunContext = {
    cwd,
    config,
    projectName: meta.name,
    projectDescription: meta.description,
    featuresRelPath: path.posix.join(specDir.replace(/\\/g, "/"), "features.json"),
    store,
    devServer,
    eventLog,
    stateStore,
    state,
    gates: buildGates(config),
    notifier,
    coder: { adapter: coderAdapter, role: coderRole },
    verifier: { adapter: verifierAdapter, role: verifierRole },
    stream: opts.stream !== false,
    agentTimeoutMs: Number(process.env.RALPH_AGENT_TIMEOUT_MS) || 30 * 60 * 1000,
  };

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.warn("\nShutting down — stopping dev server…");
    await devServer.down().catch(() => {});
    process.exit(130);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.step("Starting dev server…");
  try {
    await devServer.up();
  } catch (e) {
    throw new Error(`dev server failed to start: ${(e as Error).message}`);
  }

  try {
    await runLoop(ctx, {
      maxIterations: typeof opts.iterations === "number" ? (opts.iterations as number) : undefined,
    });
  } finally {
    await devServer.down().catch(() => {});
  }
}

// --------------------------------------------------------------------------
// ralph dev up|down|status
// --------------------------------------------------------------------------
const dev = program.command("dev").description("Manage the project dev server.");
dev
  .command("up")
  .description("Start the dev server in the background.")
  .action(async () => withConfig(async (cwd, config) => {
    await new DevServerManager(cwd, config.devServer).up();
    log.success("Dev server up.");
  }));
dev
  .command("down")
  .description("Stop the dev server.")
  .action(async () => withConfig(async (cwd, config) => {
    await new DevServerManager(cwd, config.devServer).down();
    log.success("Dev server down.");
  }));
dev
  .command("status")
  .description("Show dev server status.")
  .action(async () => withConfig(async (cwd, config) => {
    const s = new DevServerManager(cwd, config.devServer).status();
    log.info(s.running ? `running (pid ${s.pid}, port ${s.port})` : "not running");
  }));

// --------------------------------------------------------------------------
// ralph doctor
// --------------------------------------------------------------------------
program
  .command("doctor")
  .description("Diagnose the project setup (adapters, git, config, DAG).")
  .action(async () => {
    const cwd = process.cwd();
    const rows: { name: string; ok: boolean; detail: string }[] = [];
    const add = (name: string, ok: boolean, detail = "") => rows.push({ name, ok, detail });

    add("git installed", await commandExists("git"));
    add("inside git repo", await isRepo(cwd));

    const cfgPath = findConfig(cwd);
    add("ralph.config.json", !!cfgPath, cfgPath ?? "missing");

    if (cfgPath) {
      try {
        const config = loadConfig(cwd);
        add("config valid", true);
        const featuresAbs = featuresPath(cwd, config.specDir);
        if (fs.existsSync(featuresAbs)) {
          const store = new FeatureStore(featuresAbs);
          store.load();
          const dag = store.validate();
          add("features.json DAG", dag.ok, dag.ok ? `${store.counts().total} features` : dag.errors.join("; "));
        } else {
          add("features.json", false, `missing at ${featuresAbs}`);
        }
        const adapters = [resolveRole(config, "coder").adapter, resolveRole(config, "verifier").adapter];
        const avail = await probeAvailability([...new Set(adapters)]);
        for (const [name, ok] of Object.entries(avail)) add(`adapter: ${name}`, ok, ok ? "" : "not on PATH");
      } catch (e) {
        add("config valid", false, (e as Error).message.split("\n")[0]);
      }
    }

    log.info("");
    for (const r of rows) {
      const mark = r.ok ? color.green("✓") : color.red("✗");
      log.info(`  ${mark} ${r.name}${r.detail ? color.dim(" — " + r.detail) : ""}`);
    }
    const failed = rows.filter((r) => !r.ok).length;
    log.info("");
    log.info(failed ? color.yellow(`${failed} check(s) need attention.`) : color.green("All checks passed."));
    process.exitCode = failed ? 1 : 0;
  });

// --------------------------------------------------------------------------
// ralph status
// --------------------------------------------------------------------------
program
  .command("status")
  .description("Summarize the latest run from .ralph/ telemetry.")
  .action(() => {
    const cwd = process.cwd();
    const state = new RunStateStore(cwd).load();
    if (!state) {
      log.info("No run state yet. Start one with `ralph run`.");
      return;
    }
    log.info(color.bold(`Run ${state.runId.slice(0, 8)} — ${state.done ? state.haltReason || "done" : "in progress"}`));
    log.info(`  iterations: ${state.iteration}`);
    log.info(`  features:   ${state.features.verified} verified, ${state.features.passed} passed, ${state.features.blocked} blocked of ${state.features.total}`);
    log.info(`  cost:       $${state.totalCostUsd.toFixed(4)}  (${state.totalInputTokens} in / ${state.totalOutputTokens} out tokens)`);
    for (const [role, u] of Object.entries(state.perRole)) {
      log.info(color.dim(`    ${role}: ${u.invocations} calls, $${u.costUsd.toFixed(4)}, ${Math.round(u.durationMs / 1000)}s`));
    }
    const events = new EventLog(cwd).read().slice(-8);
    if (events.length) {
      log.info("");
      log.info(color.dim("  recent events:"));
      for (const e of events) log.info(color.dim(`    ${(e as { ts: string }).ts?.slice(11, 19) ?? ""} ${e.type}`));
    }
  });

// --------------------------------------------------------------------------
// ralph migrate  (v1 feature_list.json + ralph.sh → v2)
// --------------------------------------------------------------------------
program
  .command("migrate")
  .description("Migrate a v1 Ralph project (feature_list.json + ralph.sh) to v2.")
  .option("--spec-dir <dir>", "spec directory", "specs/phase1")
  .action((opts) => {
    const cwd = process.cwd();
    const specDir = opts.specDir as string;
    const v1 = path.join(cwd, specDir, "feature_list.json");
    if (!fs.existsSync(v1)) {
      log.error(`No v1 feature_list.json found at ${v1}.`);
      process.exitCode = 1;
      return;
    }
    const dest = path.join(cwd, specDir, "features.json");
    fs.copyFileSync(v1, path.join(cwd, specDir, "feature_list.json.v1.bak"));
    const migrated = migrateV1File(v1, dest);
    log.success(`Migrated ${migrated.features.length} features → ${dest} (v1 backed up as feature_list.json.v1.bak).`);

    const cfg = configPath(cwd);
    if (!fs.existsSync(cfg)) {
      const base = defaultConfig();
      base.specDir = specDir;
      const json = { $schema: "./node_modules/ralph-loop/schema/ralph.config.schema.json", ...base };
      fs.writeFileSync(cfg, JSON.stringify(json, null, 2) + "\n");
      log.success(`Wrote ${CONFIG_FILENAME} (review roles/devServer before running).`);
    }

    // Park legacy bash scripts.
    const legacy = legacyDir(cwd);
    const toPark = ["ralph.sh", "init.sh", path.join("scripts", "dev-up.sh"), path.join("scripts", "dev-down.sh"), path.join("scripts", "dev-cleanup.sh")];
    let parked = 0;
    for (const rel of toPark) {
      const src = path.join(cwd, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(legacy, rel)), { recursive: true });
        fs.renameSync(src, path.join(legacy, rel));
        parked++;
      }
    }
    if (parked) log.info(color.dim(`  Parked ${parked} legacy bash script(s) under .ralph/legacy/. The 'ralph' CLI replaces them.`));
    ensureRalphGitignored(cwd);
    log.info("Next: review ralph.config.json, then `ralph doctor` and `ralph run`.");
  });

program.parseAsync(process.argv);


// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
async function withConfig(fn: (cwd: string, config: ReturnType<typeof loadConfig>) => Promise<void>): Promise<void> {
  const cwd = process.cwd();
  try {
    await fn(cwd, loadConfig(cwd));
  } catch (e) {
    log.error((e as Error).message);
    process.exitCode = 1;
  }
}

function readProjectMeta(cwd: string): { name: string; description?: string } {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return { name: pj.name ?? path.basename(cwd), description: pj.description };
  } catch {
    return { name: path.basename(cwd) };
  }
}

function ensureRalphGitignored(cwd: string): void {
  const gi = path.join(cwd, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(gi, "utf8");
  } catch {
    /* no gitignore yet */
  }
  if (!/^\.ralph\/?\s*$/m.test(text)) {
    fs.writeFileSync(gi, (text && !text.endsWith("\n") ? text + "\n" : text) + ".ralph/\n");
  }
}
