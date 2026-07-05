import { describe, expect, it } from "vitest";
import {
  extractBlock,
  parseRalphResult,
  parseRalphVerdict,
  parseRalphPlanUpdate,
} from "./blocks";

describe("extractBlock", () => {
  it("returns the inner content of a single block, trimmed", () => {
    expect(extractBlock("before <t>  hi  </t> after", "t")).toBe("hi");
  });

  it("returns the LAST occurrence when a block is restated", () => {
    const text = "<t>first</t> noise <t>second</t>";
    expect(extractBlock(text, "t")).toBe("second");
  });

  it("tolerates surrounding markdown and newlines", () => {
    const text = "## heading\n\nsome prose\n\n<ralph-result>\n{\"a\":1}\n</ralph-result>\n\ndone";
    expect(extractBlock(text, "ralph-result")).toBe('{"a":1}');
  });

  it("returns null when the tag is absent", () => {
    expect(extractBlock("no tags here", "ralph-result")).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(extractBlock("<T>hi</T>", "t")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractBlock("", "t")).toBeNull();
  });
});

describe("parseRalphResult", () => {
  it("parses a valid result block and applies defaults", () => {
    const text = `blah\n<ralph-result>{"feature":"FEAT-1","outcome":"implemented"}</ralph-result>`;
    const out = parseRalphResult(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.feature).toBe("FEAT-1");
      expect(out.value.outcome).toBe("implemented");
      expect(out.value.summary).toBe("");
      expect(out.value.blockers).toEqual([]);
    }
  });

  it("parses a block wrapped in a ```json fence", () => {
    const text = [
      "<ralph-result>",
      "```json",
      '{"feature":"FEAT-2","outcome":"blocked","blockers":["db down"]}',
      "```",
      "</ralph-result>",
    ].join("\n");
    const out = parseRalphResult(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.outcome).toBe("blocked");
      expect(out.value.blockers).toEqual(["db down"]);
    }
  });

  it("uses the LAST block when the agent restates", () => {
    const text =
      `<ralph-result>{"feature":"A","outcome":"partial"}</ralph-result>` +
      `\n...\n` +
      `<ralph-result>{"feature":"B","outcome":"implemented"}</ralph-result>`;
    const out = parseRalphResult(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.feature).toBe("B");
  });

  it("fails closed on malformed JSON", () => {
    const text = `<ralph-result>{feature: not json}</ralph-result>`;
    const out = parseRalphResult(text);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/invalid JSON/);
  });

  it("fails closed on a schema violation (bad outcome)", () => {
    const text = `<ralph-result>{"feature":"X","outcome":"done"}</ralph-result>`;
    const out = parseRalphResult(text);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/);
  });

  it("fails closed when the block is absent", () => {
    const out = parseRalphResult("nothing here");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/missing/);
  });

  it("fails closed on empty input", () => {
    expect(parseRalphResult("").ok).toBe(false);
  });
});

describe("parseRalphVerdict", () => {
  it("parses a valid verdict with steps", () => {
    const text = `<ralph-verdict>{"verdict":"pass","steps":[{"step":"loads","ok":true}]}</ralph-verdict>`;
    const out = parseRalphVerdict(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.verdict).toBe("pass");
      expect(out.value.steps[0]).toEqual({ step: "loads", ok: true });
      expect(out.value.concerns).toEqual([]);
    }
  });

  it("fails closed on a bad verdict value", () => {
    const text = `<ralph-verdict>{"verdict":"maybe"}</ralph-verdict>`;
    expect(parseRalphVerdict(text).ok).toBe(false);
  });
});

describe("parseRalphPlanUpdate", () => {
  it("parses operations and passes through extra keys", () => {
    const text = `<ralph-plan-update>{"operations":[{"op":"reprioritize","featureId":"F1","priority":2,"extra":"keep"}],"summary":"tidy"}</ralph-plan-update>`;
    const out = parseRalphPlanUpdate(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.summary).toBe("tidy");
      expect(out.value.operations[0].op).toBe("reprioritize");
      expect((out.value.operations[0] as Record<string, unknown>).extra).toBe("keep");
    }
  });

  it("defaults operations to an empty array", () => {
    const text = `<ralph-plan-update>{"summary":"noop"}</ralph-plan-update>`;
    const out = parseRalphPlanUpdate(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.operations).toEqual([]);
  });

  it("fails closed on an unknown op", () => {
    const text = `<ralph-plan-update>{"operations":[{"op":"nuke"}]}</ralph-plan-update>`;
    expect(parseRalphPlanUpdate(text).ok).toBe(false);
  });

  it("fails closed when absent", () => {
    expect(parseRalphPlanUpdate("no block").ok).toBe(false);
  });
});
