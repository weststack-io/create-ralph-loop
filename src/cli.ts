#!/usr/bin/env node

import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { execSync, spawnSync } from "child_process";

const TEMPLATE_DIR = path.join(__dirname, "..", "template");
const RALPH_MARKER = "RALPH LOOP";
const RALPH_GITIGNORE_ENTRIES = [
  ".dev-server.pid",
  ".dev-server.log",
  "specs/phase1/screenshots/",
];

interface TemplateVars {
  projectName: string;
  projectSlug: string;
  projectDescription: string;
  createdAt: string;
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
  generateSpecs?: boolean;
  codex?: boolean;
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

function replaceTemplateVars(content: string, vars: TemplateVars): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return (vars as unknown as Record<string, string>)[key] ?? `{{${key}}}`;
  });
}

function templateDestPath(entry: string): string {
  const relativePath = path.relative(TEMPLATE_DIR, entry);
  let destPath = relativePath;
  const basename = path.basename(destPath);
  if (basename.startsWith("_")) {
    destPath = path.join(path.dirname(destPath), "." + basename.slice(1));
  }
  if (destPath.endsWith(".hbs")) {
    destPath = destPath.slice(0, -4);
  }
  return destPath;
}

async function renderTemplateEntry(
  entry: string,
  vars: TemplateVars
): Promise<Buffer | string> {
  const isTemplate = entry.endsWith(".hbs") || path.basename(entry) === "init.sh";
  if (!isTemplate) {
    return fs.readFile(entry);
  }
  const content = await fs.readFile(entry, "utf-8");
  return replaceTemplateVars(content, vars);
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

  await chmodShellScripts(targetDir);
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

async function chmodShellScripts(targetDir: string): Promise<void> {
  const shFiles = (await walkDir(targetDir)).filter((f) => f.endsWith(".sh"));
  for (const sh of shFiles) {
    try {
      fs.chmodSync(sh, 0o755);
    } catch {
      // chmod may not work on Windows, safe to ignore.
    }
  }
}

async function readPackageJson(targetDir: string): Promise<Record<string, any> | null> {
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
  let defaultPort = "3000";
  if (deps.next) {
    framework = "Next.js";
    defaultPort = "3000";
  } else if (deps.vite || deps["@vitejs/plugin-react"]) {
    framework = "Vite";
    defaultPort = "5173";
  } else if (deps["@remix-run/dev"] || deps["@remix-run/react"]) {
    framework = "Remix";
    defaultPort = "3000";
  } else if (deps.astro) {
    framework = "Astro";
    defaultPort = "4321";
  }

  return {
    packageManager,
    framework,
    installCommand:
      packageManager === "npm"
        ? "npm install"
        : packageManager === "pnpm"
          ? "pnpm install"
          : "yarn install",
    devCommand: scriptCommand(packageManager, scripts.dev ? "dev" : scripts.start ? "start" : "dev"),
    testCommand: scripts.test ? scriptCommand(packageManager, "test") : "",
    port: process.env.PORT || defaultPort,
    packageName: pkg?.name,
    packageDescription: pkg?.description,
  };
}

function scriptCommand(packageManager: ProjectDetection["packageManager"], script: string): string {
  if (packageManager === "npm") {
    return `npm run ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  return `yarn ${script}`;
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

  if (!options.yes && !detection) {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "projectName",
        message: "Project name:",
        default: toTitleCase(dirName),
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
  } else if (!options.yes && detection) {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "projectName",
        message: "Project name:",
        default: projectName,
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
  };
}

function adoptFileSet(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "README.md" || normalized === ".env.example") {
    return false;
  }
  if (normalized === ".gitignore") {
    return false;
  }
  return true;
}

async function adopt(
  targetDir: string,
  vars: TemplateVars,
  detection: ProjectDetection,
  options: CliOptions
): Promise<void> {
  const entries = await walkDir(TEMPLATE_DIR);

  for (const entry of entries) {
    const relativePath = templateDestPath(entry);
    if (!adoptFileSet(relativePath)) {
      continue;
    }

    const destPath = path.join(targetDir, relativePath);
    let rendered: Buffer | string;
    if (relativePath === "init.sh") {
      rendered = renderAdoptInit(vars, detection);
    } else if (relativePath === path.join("scripts", "dev-up.sh")) {
      rendered = renderAdoptDevUp(detection);
    } else if (relativePath === path.join("scripts", "dev-down.sh")) {
      rendered = renderAdoptDevDown(detection);
    } else if (
      relativePath === path.join("specs", "phase1", "prompts", "init_prompt.md")
    ) {
      rendered = renderAdoptInitializerPrompt(vars);
    } else {
      rendered = await renderTemplateEntry(entry, vars);
    }

    await writeAdoptFile(destPath, relativePath, rendered, options);
  }

  await appendGitignoreEntries(path.join(targetDir, ".gitignore"));
  await chmodShellScripts(targetDir);
}

async function writeAdoptFile(
  destPath: string,
  relativePath: string,
  content: Buffer | string,
  options: CliOptions
): Promise<void> {
  if (!(await fs.pathExists(destPath))) {
    await fs.ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, content);
    console.log(`Added ${relativePath}`);
    return;
  }

  if (relativePath === ".mcp.json") {
    const merged = await mergeMcpJson(destPath, content.toString());
    if (merged) {
      console.log("Merged .mcp.json");
    } else {
      console.log("Skipped .mcp.json (existing JSON could not be merged)");
    }
    return;
  }

  if (options.yes) {
    console.log(`Skipped ${relativePath} (already exists)`);
    return;
  }

  const choices = markdownMergeSupported(relativePath)
    ? ["skip", "overwrite", "merge"]
    : ["skip", "overwrite"];
  const answer = await inquirer.prompt<{ action: ConflictAction }>([
    {
      type: "list",
      name: "action",
      message: `${relativePath} already exists. What should happen?`,
      choices,
      default: "skip",
    },
  ]);

  if (answer.action === "skip") {
    console.log(`Skipped ${relativePath}`);
    return;
  }

  if (answer.action === "merge") {
    await appendMarkdownSection(destPath, content.toString());
    console.log(`Merged ${relativePath}`);
    return;
  }

  await fs.writeFile(destPath, content);
  console.log(`Overwrote ${relativePath}`);
}

function markdownMergeSupported(relativePath: string): boolean {
  return relativePath === "CLAUDE.md" || relativePath === "AGENTS.md";
}

async function appendMarkdownSection(destPath: string, content: string): Promise<void> {
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

async function mergeMcpJson(destPath: string, incomingContent: string): Promise<boolean> {
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
  console.log("Updated .gitignore with Ralph Loop runtime files");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderAdoptInit(vars: TemplateVars, detection: ProjectDetection): string {
  const testLine = detection.testCommand
    ? `echo "  To run tests:         ${detection.testCommand}"`
    : `echo "  To run tests:         no test script detected"`;
  return `#!/usr/bin/env bash
# ${vars.projectName} -- Development Environment Setup
# This script is idempotent -- safe to re-run at any time.

set -euo pipefail

echo "========================================"
echo "  ${vars.projectName} -- Dev Environment Setup"
echo "========================================"
echo ""

check_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is not installed. Please install it before continuing."
    exit 1
  fi
}

check_tool node
check_tool git
check_tool ${detection.packageManager}

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required. Current: $(node -v)"
  exit 1
fi

if [ -f "package.json" ]; then
  echo "Installing dependencies with ${detection.packageManager}..."
  ${detection.installCommand}
else
  echo "No package.json found; skipping dependency install."
fi

if [ -f "prisma/schema.prisma" ]; then
  echo "Generating Prisma client..."
  npx prisma generate || true
fi

if [ -f ".env.example" ] && [ ! -f ".env.local" ]; then
  echo "Creating .env.local from .env.example..."
  cp .env.example .env.local
fi

echo ""
echo "========================================"
echo "  Setup Summary"
echo "========================================"
echo "  Framework:   ${detection.framework}"
echo "  Package mgr: ${detection.packageManager}"
echo "  Dev command: ${detection.devCommand}"
${testLine}
echo "  Dev server:  ./scripts/dev-up.sh"
echo "========================================"
`;
}

function renderAdoptDevUp(detection: ProjectDetection): string {
  return `#!/usr/bin/env bash
# Start the detected dev server in the background.
# Idempotent: kills any stale instance first, waits until the new one is ready.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
LOG_FILE=".dev-server.log"
PORT="\${PORT:-${detection.port}}"
READY_TIMEOUT="\${READY_TIMEOUT:-180}"
DEV_COMMAND=${shellQuote(detection.devCommand)}

kill_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then return 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  kill_pid "$OLD_PID"
  rm -f "$PID_FILE"
fi

port_in_use() {
  if command -v fuser >/dev/null 2>&1 && fuser -s "\${PORT}/tcp" 2>/dev/null; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -ti:"$PORT" 2>/dev/null || true)" ]; then
    return 0
  fi
  return 1
}

clear_port() {
  local sig="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill "$sig" $pids 2>/dev/null || true
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "$sig" "\${PORT}/tcp" 2>/dev/null || true
  fi
}

if port_in_use; then
  echo "Clearing stray process(es) on port $PORT"
  clear_port -TERM
  sleep 1
  port_in_use && clear_port -KILL
  sleep 0.5
fi

: > "$LOG_FILE"
bash -lc "$DEV_COMMAND" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "$NEW_PID" > "$PID_FILE"
echo "Started dev server (pid $NEW_PID), logging to $LOG_FILE"

DEADLINE=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "ERROR: dev server process exited before becoming ready." >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  if grep -qE '(Ready in|started server on|Local:[[:space:]]+http|localhost:|http://)' "$LOG_FILE" 2>/dev/null; then
    echo "Dev server ready on http://localhost:\${PORT}/ (per log)"
    exit 0
  fi
  if curl -fsS --connect-timeout 3 --max-time 5 -o /dev/null "http://localhost:\${PORT}/" 2>/dev/null; then
    echo "Dev server ready on http://localhost:\${PORT}/"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "ERROR: dev server did not become ready within \${READY_TIMEOUT}s." >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.5
done
`;
}

function renderAdoptDevDown(detection: ProjectDetection): string {
  return `#!/usr/bin/env bash
# Stop the detected dev server.
# Idempotent: safe to run when nothing is up.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
PORT="\${PORT:-${detection.port}}"

kill_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then return 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    kill_pid "$PID"
    echo "Stopped dev server (pid $PID)"
  fi
  rm -f "$PID_FILE"
fi

port_in_use() {
  if command -v fuser >/dev/null 2>&1 && fuser -s "\${PORT}/tcp" 2>/dev/null; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -ti:"$PORT" 2>/dev/null || true)" ]; then
    return 0
  fi
  return 1
}

clear_port() {
  local sig="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill "$sig" $pids 2>/dev/null || true
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "$sig" "\${PORT}/tcp" 2>/dev/null || true
  fi
}

if port_in_use; then
  echo "Clearing stray process(es) on port $PORT"
  clear_port -TERM
  sleep 1
  port_in_use && clear_port -KILL
fi
`;
}

function renderAdoptInitializerPrompt(vars: TemplateVars): string {
  return `# ${vars.projectName} -- Adopted Project Initialization Prompt

This project already existed before Ralph Loop was adopted. Do not scaffold a new app, run create-next-app, replace package configuration, or rewrite existing source files.

Use this prompt only to prepare Ralph planning files for the existing codebase.

## Deliverables

1. Read the current project structure, documentation, package scripts, source files, routes, APIs, tests, and configuration.
2. Update \`specs/phase1/PRD.md\` so it describes the current product and known gaps.
3. Update \`specs/phase1/app_spec.txt\` so it documents the actual architecture, stack, data flow, commands, routes, UI, and environment variables.
4. Update \`specs/phase1/feature_list.json\` so already-working existing features have \`"passes": true\`, and future Ralph work has \`"passes": false\`.
5. Append an initial adoption entry to \`progress.txt\` summarizing what was discovered.

## Rules

- Do not modify application source code.
- Do not change \`package.json\`, lockfiles, framework config, or CI config.
- Do not install dependencies unless the user has explicitly prepared the environment for that.
- Do not mark a feature as passing unless it can be verified from existing code, tests, or manual inspection.
- Prefer this project's existing conventions over generic Ralph greenfield defaults.
`;
}

async function runSpecGeneration(
  targetDir: string,
  options: CliOptions
): Promise<void> {
  const promptPath = path.join(
    targetDir,
    "specs",
    "phase1",
    "prompts",
    "adopt_spec_prompt.md"
  );
  if (!(await fs.pathExists(promptPath))) {
    throw new Error("adopt_spec_prompt.md was not installed.");
  }
  const prompt = await fs.readFile(promptPath, "utf-8");
  const runner = options.codex ? "codex" : "claude";
  const probe = spawnSync(runner, ["--version"], { stdio: "pipe" });
  if (probe.error) {
    throw new Error(
      `Cannot run --generate-specs because '${runner}' is not installed or not on PATH. Adoption completed; install ${runner} and rerun with --generate-specs.`
    );
  }

  console.log(`Generating specs with ${runner}...`);
  const result = options.codex
    ? spawnSync("codex", ["exec", "--yolo", prompt], {
        cwd: targetDir,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
    : spawnSync(
        "claude",
        [
          "-p",
          prompt,
          "--allowedTools",
          "Read,Write,Edit,Glob,Grep,Bash",
        ],
        {
          cwd: targetDir,
          stdio: "inherit",
          shell: process.platform === "win32",
        }
      );

  if (result.status !== 0) {
    throw new Error(`${runner} failed while generating specs.`);
  }
}

async function runGreenfield(
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
  } else if (!projectDir) {
    projectDir = "my-ralph-project";
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

async function runAdopt(
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

  await adopt(targetDir, vars, detection, options);

  if (options.generateSpecs) {
    await runSpecGeneration(targetDir, options);
  }

  printAdoptNextSteps(options);
}

function printGreenfieldNextSteps(projectDir: string): void {
  console.log("");
  console.log("Done! Your Ralph loop project is ready.");
  console.log("");
  console.log("Next steps:");
  console.log("");
  console.log(`  cd ${projectDir}`);
  console.log("");
  console.log("  1. Fill in your specs:");
  console.log("     - specs/phase1/PRD.md              (product requirements)");
  console.log("     - specs/phase1/app_spec.txt        (technical spec)");
  console.log("     - specs/phase1/feature_list.json   (feature catalog)");
  console.log("");
  console.log("  2. Run the initializer (once):");
  console.log('     claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \\');
  console.log('       --allowedTools "Read,Write,Edit,Glob,Grep,Bash"');
  console.log("");
  console.log("  3. Run the Ralph loop:");
  console.log("     ./ralph.sh --claude 20");
  console.log("");
}

function printAdoptNextSteps(options: CliOptions): void {
  console.log("");
  console.log("Done! Ralph Loop adoption is ready.");
  console.log("");
  console.log("Next steps:");
  console.log("");
  if (!options.generateSpecs) {
    console.log("  1. Review or generate adopted specs:");
    console.log('     claude -p "$(cat specs/phase1/prompts/adopt_spec_prompt.md)" \\');
    console.log('       --allowedTools "Read,Write,Edit,Glob,Grep,Bash"');
    console.log("");
    console.log("     Or rerun:");
    console.log("     npx create-ralph-loop --adopt --generate-specs");
    console.log("");
  }
  console.log("  2. Review adopted scripts:");
  console.log("     ./init.sh");
  console.log("     ./scripts/dev-up.sh");
  console.log("");
  console.log("  3. Run the Ralph loop:");
  console.log("     ./ralph.sh --claude 20");
  console.log("");
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("create-ralph-loop")
    .description(
      "Scaffold or adopt a Ralph agentic automation loop for AI-driven iterative development"
    )
    .argument("[project-directory]", "Directory to create or adopt")
    .option("-y, --yes", "Use defaults for all prompts", false)
    .option("--no-git", "Skip git init in greenfield mode")
    .option("--no-install", "Reserved for compatibility; generated scripts still install dependencies")
    .option("--adopt", "Adopt Ralph Loop into an existing project")
    .option("--init", "Alias for --adopt")
    .option("--generate-specs", "Generate adopted specs using an installed agent CLI")
    .option("--codex", "Use Codex instead of Claude for --generate-specs")
    .action(async (projectDir: string | undefined, options: CliOptions) => {
      if (options.adopt || options.init) {
        await runAdopt(projectDir, options);
      } else {
        await runGreenfield(projectDir, options);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
