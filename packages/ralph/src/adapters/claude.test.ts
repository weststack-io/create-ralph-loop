import { describe, expect, it } from "vitest";
import { parseClaudeJsonOutput, permissionToAllowedTools } from "./claude";

describe("parseClaudeJsonOutput", () => {
  it("parses a realistic result payload into text + usage", () => {
    const fixture = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done — added the login form.",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1500, output_tokens: 320 },
    });

    const parsed = parseClaudeJsonOutput(fixture);
    expect(parsed.text).toBe("Done — added the login form.");
    expect(parsed.isError).toBe(false);
    expect(parsed.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 320,
      costUsd: 0.0123,
    });
    expect(parsed.structured).toBeTypeOf("object");
  });

  it("flags is_error true", () => {
    const parsed = parseClaudeJsonOutput(
      JSON.stringify({ is_error: true, result: "boom" }),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.text).toBe("boom");
  });

  it("degrades gracefully on malformed JSON", () => {
    const parsed = parseClaudeJsonOutput("not json at all {");
    expect(parsed.text).toBe("not json at all {");
    expect(parsed.usage).toBeUndefined();
    expect(parsed.isError).toBe(false);
    expect(parsed.structured).toBeUndefined();
  });

  it("omits usage when no token/cost fields are present", () => {
    const parsed = parseClaudeJsonOutput(JSON.stringify({ result: "hi" }));
    expect(parsed.usage).toBeUndefined();
    expect(parsed.text).toBe("hi");
  });
});

describe("permissionToAllowedTools", () => {
  it("maps readonly", () => {
    expect(permissionToAllowedTools("readonly")).toBe(
      "Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),mcp__playwright",
    );
  });
  it("maps edit", () => {
    expect(permissionToAllowedTools("edit")).toBe(
      "Read,Write,Edit,Glob,Grep,Bash(git diff:*),Bash(git log:*),mcp__playwright",
    );
  });
  it("maps full", () => {
    expect(permissionToAllowedTools("full")).toBe(
      "Read,Write,Edit,Glob,Grep,Bash,mcp__playwright",
    );
  });
});
