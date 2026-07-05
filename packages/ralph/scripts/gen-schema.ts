import fs from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RalphConfigSchema } from "../src/config/schema";

/**
 * Emit schema/ralph.config.schema.json so scaffolded ralph.config.json files can
 * reference it via "$schema" for editor validation + autocomplete. Run as part
 * of the package build; the output is shipped in the published tarball.
 */
const schema = zodToJsonSchema(RalphConfigSchema, {
  name: "RalphConfig",
  $refStrategy: "none",
});

const outDir = path.join(__dirname, "..", "schema");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "ralph.config.schema.json");
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
