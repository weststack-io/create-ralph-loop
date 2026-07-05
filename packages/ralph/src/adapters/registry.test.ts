import { describe, expect, it } from "vitest";
import type { AgentRequest } from "./types";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { MockAdapter } from "./mock";
import { getAdapter, probeAvailability, registerAdapter } from "./registry";

function makeReq(cwd: string): AgentRequest {
  return {
    prompt: "do the thing",
    cwd,
    role: "coder",
    permissionTier: "full",
    timeoutMs: 1000,
  };
}

describe("registry", () => {
  it("returns fresh built-in adapters", () => {
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("codex")).toBeInstanceOf(CodexAdapter);
    // fresh instances each call
    expect(getAdapter("claude")).not.toBe(getAdapter("claude"));
  });

  it("throws on unknown name", () => {
    expect(() => getAdapter("nope")).toThrow("Unknown adapter: nope");
  });

  it("consults registered factories (mock)", () => {
    registerAdapter("mock", () => MockAdapter.scripted([{ output: "ok" }]));
    const adapter = getAdapter("mock");
    expect(adapter).toBeInstanceOf(MockAdapter);
    expect(adapter.name).toBe("mock");
  });

  it("registered factories override built-ins", () => {
    const sentinel = MockAdapter.scripted([{ output: "overridden" }]);
    registerAdapter("claude", () => sentinel);
    expect(getAdapter("claude")).toBe(sentinel);
  });

  it("probeAvailability resolves unknown names to false", async () => {
    registerAdapter("mock", () => MockAdapter.scripted([{ output: "ok" }]));
    const result = await probeAvailability(["mock", "definitely-not-real"]);
    expect(result).toEqual({ mock: true, "definitely-not-real": false });
  });
});

describe("MockAdapter.scripted", () => {
  it("sequences turns, runs mutate, and repeats the last turn when exhausted", async () => {
    const mutated: string[] = [];
    const adapter = MockAdapter.scripted([
      {
        mutate: (cwd) => {
          mutated.push(cwd + "/a");
        },
        output: "turn-1",
        usage: { inputTokens: 1, outputTokens: 2 },
        exitCode: 0,
      },
      {
        mutate: async (cwd) => {
          mutated.push(cwd + "/b");
        },
        output: "turn-2",
      },
    ]);

    const r1 = await adapter.invoke(makeReq("/work"));
    expect(r1.rawOutput).toBe("turn-1");
    expect(r1.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(r1.exitCode).toBe(0);
    expect(r1.timedOut).toBe(false);

    const r2 = await adapter.invoke(makeReq("/work"));
    expect(r2.rawOutput).toBe("turn-2");

    // exhausted → repeats last output, no further mutate
    const r3 = await adapter.invoke(makeReq("/work"));
    expect(r3.rawOutput).toBe("turn-2");

    expect(mutated).toEqual(["/work/a", "/work/b"]);
  });

  it("custom handler receives incrementing callIndex", async () => {
    const seen: number[] = [];
    const adapter = new MockAdapter((_req, callIndex) => {
      seen.push(callIndex);
      return { exitCode: 0, rawOutput: String(callIndex), durationMs: 1, timedOut: false };
    });
    await adapter.invoke(makeReq("/w"));
    await adapter.invoke(makeReq("/w"));
    expect(seen).toEqual([0, 1]);
  });
});
