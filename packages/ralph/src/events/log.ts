import fs from "node:fs";
import type { RunEvent } from "./types";
import { RunEventSchema } from "./types";
import { ensureRalphDir, progressJsonlPath } from "../util/paths";

/**
 * Append-only telemetry log backing .ralph/progress.jsonl. Writers use the
 * typed RunEvent union; reads are lenient so old/newer logs stay parseable.
 * One JSON object per line makes appends crash-safe (a torn final line is
 * simply skipped on read).
 */
export class EventLog {
  constructor(private readonly cwd: string) {}

  /** Crash-safe append of a single event as one JSON line. */
  append(event: RunEvent): void {
    ensureRalphDir(this.cwd);
    fs.appendFileSync(
      progressJsonlPath(this.cwd),
      JSON.stringify(event) + "\n"
    );
  }

  /** Parse all well-formed events; malformed lines are skipped silently. */
  read(): RunEvent[] {
    const file = progressJsonlPath(this.cwd);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const events: RunEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const result = RunEventSchema.safeParse(parsed);
      if (!result.success) continue;
      events.push(result.data as unknown as RunEvent);
    }
    return events;
  }

  /** Raw file contents ("" when the log does not exist). */
  readRaw(): string {
    const file = progressJsonlPath(this.cwd);
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  }

  /** Delete the log (used by `ralph run --fresh`). */
  clear(): void {
    const file = progressJsonlPath(this.cwd);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

/** Convenience one-shot append without holding an EventLog instance. */
export function appendEvent(cwd: string, event: RunEvent): void {
  new EventLog(cwd).append(event);
}
