import path from "node:path";
import fs from "node:fs";

/** Per-project control directory holding all harness runtime state. */
export const RALPH_DIR = ".ralph";

export function ralphDir(cwd: string): string {
  return path.join(cwd, RALPH_DIR);
}

export function ensureRalphDir(cwd: string): string {
  const dir = ralphDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function progressJsonlPath(cwd: string): string {
  return path.join(ralphDir(cwd), "progress.jsonl");
}

export function runStatePath(cwd: string): string {
  return path.join(ralphDir(cwd), "run-state.json");
}

export function devServerStatePath(cwd: string): string {
  return path.join(ralphDir(cwd), "dev-server.json");
}

export function devServerLogPath(cwd: string): string {
  return path.join(ralphDir(cwd), "dev-server.log");
}

export function legacyDir(cwd: string): string {
  return path.join(ralphDir(cwd), "legacy");
}

export const CONFIG_FILENAME = "ralph.config.json";

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILENAME);
}

/** Resolve the features.json path for a given spec directory. */
export function featuresPath(cwd: string, specDir: string): string {
  return path.join(cwd, specDir, "features.json");
}
