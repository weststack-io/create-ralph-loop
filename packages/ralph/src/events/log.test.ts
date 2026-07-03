import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog, appendEvent } from "./log";
import type { RunEvent } from "./types";
import { progressJsonlPath } from "../util/paths";

function makeEvent(iteration: number): RunEvent {
  return {
    type: "iteration_start",
    ts: new Date().toISOString(),
    iteration,
    featureId: `f${iteration}`,
    featureDescription: "desc",
    attempt: 1,
  };
}

describe("EventLog", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-log-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("appends 3 events and reads them back parsed", () => {
    const log = new EventLog(cwd);
    log.append(makeEvent(1));
    log.append(makeEvent(2));
    log.append(makeEvent(3));

    const events = log.read();
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e as any).iteration)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.type === "iteration_start")).toBe(true);
  });

  it("returns [] when the log file does not exist", () => {
    expect(new EventLog(cwd).read()).toEqual([]);
    expect(new EventLog(cwd).readRaw()).toBe("");
  });

  it("skips malformed lines silently", () => {
    const log = new EventLog(cwd);
    log.append(makeEvent(1));
    // Hand-write a malformed line plus an empty line.
    fs.appendFileSync(progressJsonlPath(cwd), "this is not json\n\n");
    log.append(makeEvent(2));

    const events = log.read();
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as any).iteration)).toEqual([1, 2]);
  });

  it("clear() empties the log", () => {
    const log = new EventLog(cwd);
    log.append(makeEvent(1));
    expect(log.read()).toHaveLength(1);

    log.clear();
    expect(fs.existsSync(progressJsonlPath(cwd))).toBe(false);
    expect(log.read()).toEqual([]);
    // clear() is idempotent when the file is already gone.
    expect(() => log.clear()).not.toThrow();
  });

  it("appendEvent convenience writes to the same log", () => {
    appendEvent(cwd, makeEvent(7));
    const events = new EventLog(cwd).read();
    expect(events).toHaveLength(1);
    expect((events[0] as any).iteration).toBe(7);
  });
});
