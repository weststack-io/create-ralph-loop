import { describe, expect, it } from "vitest";
import { parseCodexOutput, permissionToSandboxArgs } from "./codex";

describe("parseCodexOutput", () => {
  it("extracts last assistant message and sums token usage from JSONL", () => {
    const jsonl = [
      JSON.stringify({ type: "task_started" }),
      JSON.stringify({ type: "agent_message", message: "Thinking...", usage: { input_tokens: 100, output_tokens: 20 } }),
      JSON.stringify({ type: "agent_message", message: "Final answer.", usage: { input_tokens: 50, output_tokens: 80 } }),
    ].join("\n");

    const parsed = parseCodexOutput(jsonl);
    expect(parsed.text).toBe("Final answer.");
    expect(parsed.usage).toEqual({ inputTokens: 150, outputTokens: 100 });
    expect(Array.isArray(parsed.structured)).toBe(true);
  });

  it("handles nested msg + token_count shapes", () => {
    const jsonl = [
      JSON.stringify({ msg: { text: "hello" }, token_count: { prompt_tokens: 10, completion_tokens: 5 } }),
    ].join("\n");
    const parsed = parseCodexOutput(jsonl);
    expect(parsed.text).toBe("hello");
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("falls back to raw stdout when no JSON lines parse", () => {
    const parsed = parseCodexOutput("plain text output\nno json here");
    expect(parsed.text).toBe("plain text output\nno json here");
    expect(parsed.usage).toBeUndefined();
    expect(parsed.structured).toBeUndefined();
  });

  it("omits usage when events carry no tokens but keeps text", () => {
    const parsed = parseCodexOutput(JSON.stringify({ message: "no tokens here" }));
    expect(parsed.text).toBe("no tokens here");
    expect(parsed.usage).toBeUndefined();
  });
});

describe("permissionToSandboxArgs", () => {
  it("maps readonly", () => {
    expect(permissionToSandboxArgs("readonly")).toEqual(["--sandbox", "read-only"]);
  });
  it("maps edit", () => {
    expect(permissionToSandboxArgs("edit")).toEqual(["--sandbox", "workspace-write"]);
  });
  it("maps full", () => {
    expect(permissionToSandboxArgs("full")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });
});
