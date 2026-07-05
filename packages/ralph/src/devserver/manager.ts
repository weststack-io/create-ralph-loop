import fs from "node:fs";
import { runShell, spawnDetached, killTree } from "../util/proc";
import { ensureRalphDir, devServerStatePath, devServerLogPath } from "../util/paths";
import { log } from "../util/logger";
import type { DevServerConfig } from "../config/schema";

/** Persisted description of the running dev server, written to `.ralph/dev-server.json`. */
export interface DevServerState {
  pid: number;
  port: number;
  command: string;
  startedAt: string;
}

/** Milliseconds between readiness polls. */
const POLL_INTERVAL_MS = 500;
/** Per-request abort timeout so a hanging connect can't stall the poll loop. */
const FETCH_TIMEOUT_MS = 3000;
/** Number of trailing bytes of the dev-server log to include in error messages. */
const LOG_TAIL_BYTES = 4000;

/**
 * Manages the lifecycle of the project's dev server: install (optional), spawn
 * (detached, output redirected to a log file), readiness polling, and teardown.
 * State is persisted to `.ralph/dev-server.json` so `down()`/`status()` work
 * across process boundaries (e.g. a later CLI invocation).
 */
export class DevServerManager {
  constructor(
    private readonly cwd: string,
    private readonly config: DevServerConfig,
  ) {}

  /** Environment for install + server: process env, config overrides, then PORT/DEV_PORT. */
  private mergedEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.config.env,
      PORT: String(this.config.port),
      DEV_PORT: String(this.config.port),
    };
  }

  /**
   * Start the dev server (idempotent). Runs the optional install command, spawns
   * the server detached, records state, then blocks until the readiness endpoint
   * answers with status < 500. Throws (after tearing down) if install fails or
   * readiness times out; the error includes the tail of the dev-server log.
   */
  async up(): Promise<void> {
    if (!this.config.enabled) {
      log.dim("Dev server disabled in config; skipping.");
      return;
    }

    if (this.status().running) {
      log.dim("Dev server already running; reusing existing process.");
      return;
    }

    if (this.config.installCommand) {
      log.step(`Installing dev-server deps: ${this.config.installCommand}`);
      const res = await runShell(this.config.installCommand, {
        cwd: this.cwd,
        env: this.mergedEnv(),
        timeoutMs: 600_000,
      });
      if (res.code !== 0) {
        throw new Error(
          `Dev-server install command failed (exit ${res.code ?? "signal " + res.signal}): ` +
            `${this.config.installCommand}\n${res.combined}`,
        );
      }
    }

    ensureRalphDir(this.cwd);
    const logFile = devServerLogPath(this.cwd);
    log.step(`Starting dev server on port ${this.config.port}: ${this.config.command}`);
    const pid = spawnDetached(this.config.command, {
      cwd: this.cwd,
      env: this.mergedEnv(),
      logFile,
    });

    const state: DevServerState = {
      pid,
      port: this.config.port,
      command: this.config.command,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(devServerStatePath(this.cwd), JSON.stringify(state, null, 2));

    const ready = await this.waitForReady();
    if (!ready) {
      const tail = this.readLogTail(logFile);
      await this.down();
      throw new Error(
        `Dev server did not become ready within ${this.config.readyTimeoutMs}ms ` +
          `(GET http://localhost:${this.config.port}${this.config.readinessPath}).\n` +
          `--- dev-server.log (tail) ---\n${tail}`,
      );
    }
    log.success(`Dev server ready on port ${this.config.port}.`);
  }

  /**
   * Stop the dev server if running and remove the state file. Idempotent: does
   * nothing (and never throws) when no server is recorded.
   */
  async down(): Promise<void> {
    const state = this.readState();
    if (state && this.isAlive(state.pid)) {
      await killTree(state.pid);
    }
    try {
      fs.rmSync(devServerStatePath(this.cwd), { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  /** Stop then start the dev server. */
  async restart(): Promise<void> {
    await this.down();
    await this.up();
  }

  /**
   * Report whether a dev server is currently running, based on the recorded
   * state file and OS-level process liveness. Stale state (dead pid) is treated
   * as not running and best-effort removed.
   */
  status(): { running: boolean; pid?: number; port?: number } {
    const state = this.readState();
    if (!state) return { running: false };
    if (this.isAlive(state.pid)) {
      return { running: true, pid: state.pid, port: state.port };
    }
    // Stale state: process is gone. Clean it up so future calls are consistent.
    try {
      fs.rmSync(devServerStatePath(this.cwd), { force: true });
    } catch {
      /* ignore */
    }
    return { running: false };
  }

  /** Read + parse the state file, returning undefined if absent or corrupt. */
  private readState(): DevServerState | undefined {
    try {
      const raw = fs.readFileSync(devServerStatePath(this.cwd), "utf8");
      return JSON.parse(raw) as DevServerState;
    } catch {
      return undefined;
    }
  }

  /** True if the pid refers to a live process (signal 0 probe). */
  private isAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Poll the readiness endpoint until it answers (status < 500) or we time out. */
  private async waitForReady(): Promise<boolean> {
    const url = `http://localhost:${this.config.port}${this.config.readinessPath}`;
    const deadline = Date.now() + this.config.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe(url)) return true;
      await sleep(POLL_INTERVAL_MS);
    }
    // One final probe in case the last sleep straddled the deadline.
    return this.probe(url);
  }

  /** Single readiness request with its own abort timeout. Returns true on status < 500. */
  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read the last LOG_TAIL_BYTES of the dev-server log for error context. */
  private readLogTail(logFile: string): string {
    try {
      const buf = fs.readFileSync(logFile);
      const start = Math.max(0, buf.length - LOG_TAIL_BYTES);
      return buf.subarray(start).toString("utf8").trim() || "(log empty)";
    } catch {
      return "(no dev-server.log found)";
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
