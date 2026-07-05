#!/usr/bin/env node

import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";
import { Eta } from "eta";

const TEMPLATE_DIR = path.join(__dirname, "..", "template");
const RALPH_MARKER = "RALPH LOOP";
const RALPH_LOOP_DEP_VERSION = "^0.1.0";
const RALPH_GITIGNORE_ENTRIES = [
  "node_modules/",
  ".env.local",
  ".ralph/",
  "specs/phase1/screenshots/",
];

// autoTrim disabled so `%>` never eats a following newline (eta gotcha).
const eta = new Eta({ autoTrim: false });

interface TemplateVars {
  projectName: string;
  projectSlug: string;
  projectDescription: string;
  createdAt: string;
  devPort: string;
  // Raw JSON fragments injected into ralph.config.json.eta.
  devCommandJson: string;
  installCommandJson: string;
  testGate: string;
}

interface ProjectDetection {
  packageManager: "npm" | "pnpm" | "yarn";
  framework: string;
  installCommand: string;
  devCommand: string;
  testCommand: string;
  port: string;
  packageName?: string;
  packageDescription?: string;
}

interface CliOptions {
  yes: boolean;
  git?: boolean;
  install?: boolean;
  adopt?: boolean;
  init?: boolean;
}

type ConflictAction = "skip" | "overwrite" | "merge";

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toTitleCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());
}

function deriveProjectPort(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return String(3000 + (hash % 1000));
}

function templateDestPath(entry: string): string {
  const relativePath = path.relative(TEMPLATE_DIR, entry);
  let destPath = relativePath;
  const basename = path.basename(destPath);
  if (basename.startsWith("_")) {
    destPath = path.join(path.dirname(destPath), "." + basename.slice(1));
  }
  if (destPath.endsWith(".eta")) {
    destPath = destPath.slice(0, -4);
  }
  return destPath;
}

async function renderTemplateEntry(
  entry: string,
  vars: TemplateVars
): Promise<Buffer | string> {
  if (!entry.endsWith(".eta")) {
    return fs.readFile(entry);
  }
  const content = await fs.readFile(entry, "utf-8");
  return eta.renderString(content, vars) as string;
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(fullPath)));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function scaffold(targetDir: string, vars: TemplateVars): Promise<void> {
  await fs.ensureDir(targetDir);

  const entries = await walkDir(TEMPLATE_DIR);
  for (const entry of entries) {
    const destPath = path.join(targetDir, templateDestPath(entry));
    const rendered = await renderTemplateEntry(entry, vars);
    await fs.ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, rendered);
  }
}

async function readPackageJson(
  targetDir: string
): Promise<Record<string, any> | null> {
  const packageJsonPath = path.join(targetDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return null;
  }
  try {
    return await fs.readJson(packageJsonPath);
  } catch {
    return null;
  }
}

async function readEnvPort(targetDir: string): Promise<string | undefined> {
  for (const fileName of [".env.local", ".env"]) {
    const envPath = path.join(targetDir, fileName);
    if (!(await fs.pathExists(envPath))) {
      continue;
    }
    const content = await fs.readFile(envPath, "utf-8");
    const match = content.match(/^(?:DEV_PORT|PORT)=(\d+)\s*$/m);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function scriptCommand(
  packageManager: ProjectDetection["packageManager"],
  script: string
): string {
  if (packageManager === "npm") {
    return `npm run ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  return `yarn ${script}`;
}

async function detectProject(targetDir: string): Promise<ProjectDetection> {
  const pkg = await readPackageJson(targetDir);
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const scripts = pkg?.scripts ?? {};

  let packageManager: ProjectDetection["packageManager"] = "npm";
  if (await fs.pathExists(path.join(targetDir, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (await fs.pathExists(path.join(targetDir, "yarn.lock"))) {
    packageManager = "yarn";
  }

  let framework = "generic Node";
  if (deps.next) {
    framework = "Next.js";
  } else if (deps.vite || deps["@vitejs/plugin-react"]) {
    framework = "Vite";
  } else if (deps["@remix-run/dev"] || deps["@remix-run/react"]) {
    framework = "Remix";
  } else if (deps.astro) {
    framework = "Astro";
  }

  const projectSeed = pkg?.name ?? path.basename(targetDir);
  const envPort = await readEnvPort(targetDir);

  return {
    packageManager,
    framework,
    installCommand:
      packageManager === "npm"
        ? "npm install"
        : packageManager === "pnpm"
          ? "pnpm install"
          : "yarn install",
    devCommand: scriptCommand(
      packageManager,
      scripts.dev ? "dev" : scripts.start ? "start" : "dev"
    ),
    testCommand: scripts.test ? scriptCommand(packageManager, "test") : "",
    port: envPort ?? deriveProjectPort(projectSeed),
    packageName: pkg?.name,
    packageDescription: pkg?.description,
  };
}

function testGateFragment(command: string): string {
  return `{ "command": ${JSON.stringify(
    command
  )}, "baselineRelative": true, "timeoutMs": 600000 }`;
}

/**
 * Derive the raw JSON fragments that feed ralph.config.json.eta. Greenfield
 * (no detection) uses sensible npm defaults; adopt threads through the detected
 * dev/install/test commands, disabling the test gate when no test script exists.
 */
function buildConfigVars(detection?: ProjectDetection): {
  devCommandJson: string;
  installCommandJson: string;
  testGate: string;
} {
  const devCommand = detection?.devCommand || "npm run dev";
  const installCommand = detection?.installCommand || "npm install";
  let testGate: string;
  if (detection) {
    testGate = detection.testCommand
      ? testGateFragment(detection.testCommand)
      : "false";
  } else {
    testGate = testGateFragment("npm test");
  }
  return {
    devCommandJson: JSON.stringify(devCommand),
    installCommandJson: JSON.stringify(installCommand),
    testGate,
  };
}

async function buildVars(
  targetDir: string,
  options: CliOptions,
  detection?: ProjectDetection
): Promise<TemplateVars> {
  const dirName = path.basename(targetDir);
  let projectName = detection?.packageName ?? dirName;
  let projectDescription =
    detection?.packageDescription ?? "An AI-powered application";

  if (!options.yes) {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "projectName",
        message: "Project name:",
        default: detection ? projectName : toTitleCase(dirName),
      },
      {
        type: "input",
        name: "projectDescription",
        message: "One-line description:",
        default: projectDescription,
      },
    ]);
    projectName = answers.projectName;
    projectDescription = answers.projectDescription;
  }

  return {
    projectName,
    projectSlug: toKebabCase(projectName),
    projectDescription,
    createdAt: new Date().toISOString().split("T")[0],
    devPort: detection?.port ?? deriveProjectPort(projectName || dirName),
    ...buildConfigVars(detection),
  };
}

// ---------------------------------------------------------------------------
// Adopt mode
// ---------------------------------------------------------------------------

/** Files we never write directly into an existing project. */
function adoptSkipDirect(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized === "README.md" ||
    normalized === ".env.example" ||
    normalized === ".gitignore"
  );
}

async function adopt(
  targetDir: string,
  vars: TemplateVars,
  options: CliOptions
): Promise<void> {
  const entries = await walkDir(TEMPLATE_DIR);

  for (const entry of entries) {
    const relativePath = templateDestPath(entry);
    if (adoptSkipDirect(relativePath)) {
      continue;
    }
    const destPath = path.join(targetDir, relativePath);
    const rendered = await renderTemplateEntry(entry, vars);
    await writeAdoptFile(destPath, relativePath, rendered, options);
  }

  await appendGitignoreEntries(path.join(targetDir, ".gitignore"));
}

async function writeAdoptFile(
  destPath: string,
  relativePath: string,
  content: Buffer | string,
  options: CliOptions
): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");

  if (!(await fs.pathExists(destPath))) {
    await fs.ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, content);
    console.log(`Added ${normalized}`);
    return;
  }

  if (normalized === ".mcp.json") {
    const merged = await mergeMcpJson(destPath, content.toString());
    console.log(
      merged
        ? "Merged .mcp.json"
        : "Skipped .mcp.json (existing JSON could not be merged)"
    );
    return;
  }

  if (options.yes) {
    console.log(`Skipped ${normalized} (already exists)`);
    return;
  }

  const choices = markdownMergeSupported(normalized)
    ? ["skip", "overwrite", "merge"]
    : ["skip", "overwrite"];
  const answer = await inquirer.prompt<{ action: ConflictAction }>([
    {
      type: "list",
      name: "action",
      message: `${normalized} already exists. What should happen?`,
      choices,
      default: "skip",
    },
  ]);

  if (answer.action === "skip") {
    console.log(`Skipped ${normalized}`);
    return;
  }

  if (answer.action === "merge") {
    await appendMarkdownSection(destPath, content.toString());
    console.log(`Merged ${normalized}`);
    return;
  }

  await fs.writeFile(destPath, content);
  console.log(`Overwrote ${normalized}`);
}

function markdownMergeSupported(relativePath: string): boolean {
  return relativePath === "CLAUDE.md" || relativePath === "AGENTS.md";
}

async function appendMarkdownSection(
  destPath: string,
  content: string
): Promise<void> {
  const existing = await fs.readFile(destPath, "utf-8");
  if (existing.includes(`BEGIN ${RALPH_MARKER}`)) {
    return;
  }
  const section = [
    "",
    `<!-- BEGIN ${RALPH_MARKER} -->`,
    content.trim(),
    `<!-- END ${RALPH_MARKER} -->`,
    "",
  ].join("\n");
  await fs.writeFile(destPath, `${existing.trimEnd()}\n${section}`, "utf-8");
}

async function mergeMcpJson(
  destPath: string,
  incomingContent: string
): Promise<boolean> {
  try {
    const existing = await fs.readJson(destPath);
    const incoming = JSON.parse(incomingContent);
    existing.mcpServers = {
      ...(existing.mcpServers ?? {}),
      ...(incoming.mcpServers ?? {}),
    };
    await fs.writeJson(destPath, existing, { spaces: 2 });
    return true;
  } catch {
    return false;
  }
}

async function appendGitignoreEntries(gitignorePath: string): Promise<void> {
  let existing = "";
  if (await fs.pathExists(gitignorePath)) {
    existing = await fs.readFile(gitignorePath, "utf-8");
  }
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = RALPH_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) {
    return;
  }
  const block = ["", "# Ralph Loop", ...missing, ""].join("\n");
  await fs.writeFile(gitignorePath, `${existing.trimEnd()}${block}`, "utf-8");
  console.log("Updated .gitignore with Ralph Loop entries");
}

/** Add ralph-loop to devDependencies if absent. Returns true if it wrote. */
async function ensureRalphLoopDevDep(targetDir: string): Promise<boolean> {
  const pkgPath = path.join(targetDir, "package.json");
  if (!(await fs.pathExists(pkgPath))) {
    return false;
  }
  const pkg = await fs.readJson(pkgPath);
  const already =
    pkg.dependencies?.["ralph-loop"] || pkg.devDependencies?.["ralph-loop"];
  if (already) {
    return false;
  }
  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.devDependencies["ralph-loop"] = RALPH_LOOP_DEP_VERSION;
  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
  console.log(`Added ralph-loop@${RALPH_LOOP_DEP_VERSION} to devDependencies`);
  return true;
}

// ---------------------------------------------------------------------------
// Entry flows
// ---------------------------------------------------------------------------

export async function runGreenfield(
  projectDir: string | undefined,
  options: CliOptions
): Promise<void> {
  if (!projectDir && !options.yes) {
    const { dir } = await inquirer.prompt([
      {
        type: "input",
        name: "dir",
        message: "Project directory:",
        default: "my-ralph-project",
      },
    ]);
    projectDir = dir;
  }

  const resolvedProjectDir = projectDir ?? "my-ralph-project";
  const targetDir = path.resolve(resolvedProjectDir);
  if (await fs.pathExists(targetDir)) {
    const contents = await fs.readdir(targetDir);
    if (contents.length > 0) {
      console.error(
        `Error: Directory "${resolvedProjectDir}" already exists and is not empty. Use --adopt to add Ralph Loop to an existing project.`
      );
      process.exit(1);
    }
  }

  const vars = await buildVars(targetDir, options);

  console.log("");
  console.log(`Creating ${vars.projectName} in ${targetDir}...`);
  console.log("");

  await scaffold(targetDir, vars);

  if (options.git !== false) {
    try {
      execSync("git init", { cwd: targetDir, stdio: "pipe" });
      console.log("Initialized git repository.");
    } catch {
      console.log("Warning: git init failed. You can do this manually.");
    }
  }

  printGreenfieldNextSteps(resolvedProjectDir);
}

export async function runAdopt(
  projectDir: string | undefined,
  options: CliOptions
): Promise<void> {
  const targetDir = path.resolve(projectDir ?? ".");
  if (!(await fs.pathExists(targetDir))) {
    console.error(`Error: Directory "${targetDir}" does not exist.`);
    process.exit(1);
  }

  const detection = await detectProject(targetDir);
  const vars = await buildVars(targetDir, options, detection);

  console.log("");
  console.log(`Adopting Ralph Loop into ${targetDir}...`);
  console.log(`Detected: ${detection.framework}, ${detection.packageManager}`);
  console.log("");

  await adopt(targetDir, vars, options);

  const addedDep = await ensureRalphLoopDevDep(targetDir);
  const hasPackageJson = await fs.pathExists(
    path.join(targetDir, "package.json")
  );

  if (hasPackageJson && options.install !== false) {
    try {
      console.log(`Installing dependencies (${detection.installCommand})...`);
      execSync(detection.installCommand, { cwd: targetDir, stdio: "inherit" });
    } catch {
      console.log(
        `Warning: '${detection.installCommand}' failed. Run it manually to install ralph-loop.`
      );
    }
  } else if (addedDep) {
    console.log("Skipped install (--no-install). Run install to fetch ralph-loop.");
  }

  printAdoptNextSteps();
}

function printGreenfieldNextSteps(projectDir: string): void {
  console.log("");
  console.log("Done! Your Ralph Loop project is ready.");
  console.log("");
  console.log("Next steps:");
  console.log("");
  console.log(`  cd ${projectDir}`);
  console.log("");
  console.log("  1. Install the runtime:");
  console.log("     npm i -D ralph-loop");
  console.log("");
  console.log("  2. Fill in your specs:");
  console.log("     - specs/phase1/PRD.md          (product requirements)");
  console.log("     - specs/phase1/app_spec.txt    (technical spec)");
  console.log("     - specs/phase1/features.json   (feature contract, seeded)");
  console.log("");
  console.log("  3. Check the setup and run the loop:");
  console.log("     npx ralph doctor");
  console.log("     npx ralph run");
  console.log("");
}

function printAdoptNextSteps(): void {
  console.log("");
  console.log("Done! Ralph Loop adoption is ready.");
  console.log("");
  console.log("Next steps:");
  console.log("");
  console.log("  1. Review ralph.config.json (roles, gates, devServer).");
  console.log("");
  console.log(
    "  2. If migrating a v1 project (feature_list.json + ralph.sh):"
  );
  console.log("     npx ralph migrate");
  console.log("");
  console.log("  3. Check the setup and run the loop:");
  console.log("     npx ralph doctor");
  console.log("     npx ralph run");
  console.log("");
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("create-ralph-loop")
    .description(
      "Scaffold or adopt a Ralph Loop (v2) autonomous-build harness for AI-driven iterative development"
    )
    .argument("[project-directory]", "Directory to create or adopt")
    .option("-y, --yes", "Use defaults for all prompts", false)
    .option("--no-git", "Skip git init in greenfield mode")
    .option("--no-install", "Skip installing dependencies in adopt mode")
    .option("--adopt", "Adopt Ralph Loop into an existing project")
    .option("--init", "Alias for --adopt")
    .action(async (projectDir: string | undefined, options: CliOptions) => {
      if (options.adopt || options.init) {
        await runAdopt(projectDir, options);
      } else {
        await runGreenfield(projectDir, options);
      }
    });

  await program.parseAsync(process.argv);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
