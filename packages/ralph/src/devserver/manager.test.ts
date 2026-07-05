import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevServerManager } from "./manager";
import type { DevServerConfig } from "../config/schema";

/** A trivial HTTP server used AS the dev command, so up()/readiness/down() run end-to-end. */
const SERVER_CMD =
  `node -e "require('http').createServer((_,res)=>res.end('ok')).listen(process.env.PORT)"`;

function makeConfig(port: number): DevServerConfig {
  return {
    enabled: true,
    installCommand: undefined,
    command: SERVER_CMD,
    port,
    readinessPath: "/",
    readyTimeoutMs: 15_000,
    env: {},
  };
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ralph-devserver-"));
}

/** Windows may lag releasing the child's log-file handle after kill; retry rm. */
async function rmDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

describe("DevServerManager end-to-end", () => {
  it("starts a real server, reports running, serves requests, then stops", async () => {
    // Pseudo-random ephemeral-ish port with one retry on collision.
    const ports = [34100 + Math.floor(Math.random() * 400), 34600 + Math.floor(Math.random() * 300)];
    const cwd = mkTmpDir();

    let lastErr: unknown;
    for (const port of ports) {
      const mgr = new DevServerManager(cwd, makeConfig(port));
      try {
        expect(mgr.status().running).toBe(false);

        await mgr.up();

        const st = mgr.status();
        expect(st.running).toBe(true);
        expect(st.pid).toBeGreaterThan(0);
        expect(st.port).toBe(port);

        const res = await fetch(`http://localhost:${port}/`);
        expect(await res.text()).toBe("ok");

        await mgr.down();
        expect(mgr.status().running).toBe(false);

        lastErr = undefined;
        break; // success
      } catch (err) {
        lastErr = err;
        await mgr.down().catch(() => {});
        // try the next port
      }
    }

    await rmDirWithRetry(cwd);
    if (lastErr) throw lastErr;
  }, 40_000);

  it("status() returns { running: false } when no state file exists", () => {
    const cwd = mkTmpDir();
    try {
      const mgr = new DevServerManager(cwd, makeConfig(34999));
      expect(mgr.status()).toEqual({ running: false });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("up() is a no-op when disabled", async () => {
    const cwd = mkTmpDir();
    try {
      const cfg = { ...makeConfig(34998), enabled: false };
      const mgr = new DevServerManager(cwd, cfg);
      await mgr.up();
      expect(mgr.status().running).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
