import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Feature } from "../features/schema";
import {
  PROMPT_NAMES,
  renderPrompt,
  resolveTemplatePath,
  type PromptName,
} from "./render";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-prompts-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function sampleFeature(): Feature {
  return {
    id: "FEAT-042",
    category: "feature",
    priority: 1,
    description: "Users can reset their password",
    steps: ["Request a reset email", "Follow the link", "Set a new password"],
    depends_on: [],
    status: "pending",
    attempts: 0,
    blocked_reason: null,
    verification: null,
    lease: null,
  };
}

describe("resolveTemplatePath", () => {
  it("prefers a project override over the packaged default", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const overrideDir = path.join(cwd, specDir, "prompts");
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, "coding.md"), "override body");

    const resolved = resolveTemplatePath("coding", { cwd, specDir });
    expect(resolved.source).toBe("override");
    expect(resolved.path).toBe(path.join(overrideDir, "coding.md"));
  });

  it("prefers a .eta override over a .md override", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const overrideDir = path.join(cwd, specDir, "prompts");
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, "coding.eta"), "eta body");
    fs.writeFileSync(path.join(overrideDir, "coding.md"), "md body");

    const resolved = resolveTemplatePath("coding", { cwd, specDir });
    expect(resolved.path.endsWith("coding.eta")).toBe(true);
  });

  it("falls back to the packaged default when there is no override", () => {
    const cwd = mkTmp();
    const resolved = resolveTemplatePath("coding", { cwd, specDir: "specs/phase1" });
    expect(resolved.source).toBe("default");
    expect(fs.existsSync(resolved.path)).toBe(true);
  });
});

describe("renderPrompt", () => {
  it("renders the coding prompt with the injected feature", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const out = renderPrompt(
      "coding",
      {
        projectName: "Acme",
        projectDescription: "a widget shop",
        devPort: 4321,
        specDir,
        feature: sampleFeature(),
        iteration: 3,
        attempt: 1,
      },
      { cwd, specDir }
    );
    expect(out).toContain("FEAT-042");
    expect(out).toContain("Users can reset their password");
    expect(out).toContain("4321");
    // steps rendered
    expect(out).toContain("Request a reset email");
    // hard rule about features.json ownership
    expect(out).toContain("features.json");
  });

  it("renders the retry section only when previousFailure is present", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const base = {
      projectName: "Acme",
      devPort: 3000,
      specDir,
      feature: sampleFeature(),
      iteration: 2,
      attempt: 2,
    };
    const without = renderPrompt("coding", base, { cwd, specDir });
    expect(without).not.toContain("Previous attempt failed");

    const withFailure = renderPrompt(
      "coding",
      {
        ...base,
        previousFailure: {
          gates: ["tsc"],
          verifierConcerns: ["missing authz"],
          detail: "The reset token was not validated.",
        },
      },
      { cwd, specDir }
    );
    expect(withFailure).toContain("Previous attempt failed");
    expect(withFailure).toContain("The reset token was not validated.");
  });

  it("uses a project override when present", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const overrideDir = path.join(cwd, specDir, "prompts");
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, "coding.md"), "OVERRIDE <%= it.projectName %>");

    const out = renderPrompt(
      "coding",
      { projectName: "Zeta", devPort: 3000, specDir, feature: sampleFeature(), iteration: 1, attempt: 1 },
      { cwd, specDir }
    );
    expect(out).toBe("OVERRIDE Zeta");
  });

  it("renders every packaged default template with a minimal context without throwing", () => {
    const cwd = mkTmp();
    const specDir = "specs/phase1";
    const ctx = {
      projectName: "Acme",
      projectDescription: "a widget shop",
      devPort: 3000,
      specDir,
      feature: sampleFeature(),
      iteration: 1,
      attempt: 1,
      diffSummary: "changed src/auth.ts",
      featuresJson: '{"version":2,"features":[]}',
      recentEvents: "nothing notable",
      gitLog: "abc123 feat: x",
    };
    for (const name of PROMPT_NAMES as PromptName[]) {
      const out = renderPrompt(name, ctx, { cwd, specDir });
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
