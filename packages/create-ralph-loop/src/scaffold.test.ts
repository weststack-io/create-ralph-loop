import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { runGreenfield } from "./cli";
import { RalphConfigSchema } from "../../ralph/src/config/schema";
import { FeatureFileSchema } from "../../ralph/src/features/schema";

describe("create-ralph-loop greenfield scaffold", () => {
  let tmpRoot: string;
  let projectDir: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crl-scaffold-"));
    projectDir = path.join(tmpRoot, "my-app");
    await runGreenfield(projectDir, { yes: true, git: false, install: false });
  });

  afterAll(async () => {
    await fs.remove(tmpRoot);
  });

  it("renders a valid ralph.config.json", async () => {
    const cfgPath = path.join(projectDir, "ralph.config.json");
    expect(await fs.pathExists(cfgPath)).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgPath, "utf-8"));
    const parsed = RalphConfigSchema.parse(raw);
    expect(parsed.version).toBe(2);
    expect(parsed.specDir).toBe("specs/phase1");
    expect(parsed.devServer.command).toBe("npm run dev");
    expect(parsed.devServer.port).toBeGreaterThanOrEqual(3000);
  });

  it("renders a valid v2 features.json", async () => {
    const featuresPath = path.join(projectDir, "specs", "phase1", "features.json");
    expect(await fs.pathExists(featuresPath)).toBe(true);
    const raw = JSON.parse(await fs.readFile(featuresPath, "utf-8"));
    const parsed = FeatureFileSchema.parse(raw);
    expect(parsed.version).toBe(2);
    const ids = parsed.features.map((f) => f.id);
    expect(ids).toContain("INFRA-001");
    expect(ids).toContain("INFRA-002");
    expect(ids).toContain("UI-001");
  });

  it("does not emit legacy bash scaffolding", async () => {
    expect(await fs.pathExists(path.join(projectDir, "ralph.sh"))).toBe(false);
    expect(await fs.pathExists(path.join(projectDir, "init.sh"))).toBe(false);
    expect(await fs.pathExists(path.join(projectDir, "scripts"))).toBe(false);
  });

  it("writes a .gitignore that ignores .ralph/", async () => {
    const gitignore = await fs.readFile(
      path.join(projectDir, ".gitignore"),
      "utf-8"
    );
    expect(gitignore).toContain(".ralph/");
  });

  it("renders docs skeleton and no leftover template markers", async () => {
    expect(
      await fs.pathExists(path.join(projectDir, "docs", "tech-debt.md"))
    ).toBe(true);
    const claude = await fs.readFile(
      path.join(projectDir, "CLAUDE.md"),
      "utf-8"
    );
    expect(claude).not.toContain("<%");
    expect(claude).not.toContain("{{");
  });
});
