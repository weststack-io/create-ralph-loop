import fs from "node:fs";
import { z } from "zod";
import { configPath } from "../util/paths";
import { RalphConfig, parseConfig } from "./schema";

/** Locate ralph.config.json for a project root; null if absent. */
export function findConfig(cwd: string): string | null {
  const p = configPath(cwd);
  return fs.existsSync(p) ? p : null;
}

/**
 * Load + validate ralph.config.json. Throws a readable Error (including zod
 * issue paths) rather than a raw ZodError so the CLI can print it cleanly.
 */
export function loadConfig(cwd: string): RalphConfig {
  const p = findConfig(cwd);
  if (!p) {
    throw new Error(
      `No ${configPath(cwd)} found. Scaffold with 'create-ralph-loop' or run 'ralph migrate' in an existing Ralph project.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${p}: ${(e as Error).message}`);
  }
  try {
    return parseConfig(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const lines = e.issues.map(
        (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      throw new Error(`Invalid ${p}:\n${lines.join("\n")}`);
    }
    throw e;
  }
}
