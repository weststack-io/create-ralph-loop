import { describe, it, expect } from "vitest";
import { parseAiderOutput, permissionToAiderArgs } from "./aider";

describe("parseAiderOutput", () => {
  it("parses tokens and cost from the footer", () => {
    const out = "Applied edit to src/x.ts\nTokens: 12k sent, 340 received. Cost: $0.02 message, $0.05 session.";
    const { usage } = parseAiderOutput(out);
    expect(usage?.inputTokens).toBe(12000);
    expect(usage?.outputTokens).toBe(340);
    expect(usage?.costUsd).toBe(0.02);
  });

  it("returns no usage when nothing matches", () => {
    expect(parseAiderOutput("just some text").usage).toBeUndefined();
  });

  it("maps permission tiers", () => {
    expect(permissionToAiderArgs("readonly")).toEqual(["--chat-mode", "ask"]);
    expect(permissionToAiderArgs("edit")).toEqual([]);
    expect(permissionToAiderArgs("full")).toEqual([]);
  });
});
