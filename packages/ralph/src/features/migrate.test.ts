import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateV1, migrateV1File } from "./migrate";
import { FeatureFileSchema } from "./schema";

describe("migrateV1", () => {
  it("maps passes:true to verified with a migrated verification", () => {
    const out = migrateV1({
      features: [
        { id: "1", priority: 1, description: "done thing", passes: true },
      ],
    });
    const f = out.features[0];
    expect(f.status).toBe("verified");
    expect(f.verification).toMatchObject({ verdict: "pass", migrated: true });
    expect(typeof f.verification!.at).toBe("string");
    expect(f.category).toBe("feature");
    expect(f.steps).toEqual([]);
    expect(f.depends_on).toEqual([]);
  });

  it("maps passes:false to pending with null verification", () => {
    const out = migrateV1({
      features: [
        { id: "2", priority: 2, description: "todo thing", passes: false },
      ],
    });
    const f = out.features[0];
    expect(f.status).toBe("pending");
    expect(f.verification).toBeNull();
    expect(f.attempts).toBe(0);
    expect(f.lease).toBeNull();
  });

  it("accepts a bare array input", () => {
    const out = migrateV1([
      { id: "a", priority: 1, description: "x", passes: true },
      { id: "b", priority: 2, description: "y", passes: false, category: "chore", steps: ["s1"] },
    ]);
    expect(out.version).toBe(2);
    expect(out.features.length).toBe(2);
    expect(out.features[1].category).toBe("chore");
    expect(out.features[1].steps).toEqual(["s1"]);
  });

  it("output validates against FeatureFileSchema", () => {
    const out = migrateV1([{ id: "a", priority: 1, description: "x", passes: true }]);
    expect(() => FeatureFileSchema.parse(out)).not.toThrow();
  });

  it("throws on malformed v1 data", () => {
    expect(() => migrateV1({ features: [{ id: "a" }] })).toThrow();
  });
});

describe("migrateV1File", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-migrate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads src, writes dest, returns the file", () => {
    const src = path.join(dir, "v1.json");
    const dest = path.join(dir, "features.json");
    fs.writeFileSync(
      src,
      JSON.stringify([{ id: "a", priority: 1, description: "x", passes: true }]),
      "utf8",
    );
    const out = migrateV1File(src, dest);
    expect(out.version).toBe(2);
    const onDisk = fs.readFileSync(dest, "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(JSON.parse(onDisk)).toEqual(out);
  });
});
