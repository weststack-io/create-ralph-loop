#!/usr/bin/env node

import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";

const TEMPLATE_DIR = path.join(__dirname, "..", "template");

interface TemplateVars {
  projectName: string;
  projectSlug: string;
  projectDescription: string;
  createdAt: string;
}

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function replaceTemplateVars(content: string, vars: TemplateVars): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return (vars as unknown as Record<string, string>)[key] ?? `{{${key}}}`;
  });
}

async function scaffold(targetDir: string, vars: TemplateVars): Promise<void> {
  await fs.ensureDir(targetDir);

  const entries = await walkDir(TEMPLATE_DIR);

  for (const entry of entries) {
    const relativePath = path.relative(TEMPLATE_DIR, entry);
    let destPath = path.join(targetDir, relativePath);

    // Rename _ prefixed files to . prefixed (npm ignores dotfiles in packages)
    const basename = path.basename(destPath);
    if (basename.startsWith("_")) {
      destPath = path.join(path.dirname(destPath), "." + basename.slice(1));
    }

    // Handle .hbs template files
    const isTemplate = destPath.endsWith(".hbs");
    if (isTemplate) {
      destPath = destPath.slice(0, -4); // strip .hbs
    }

    // Also apply template substitution to .hbs renamed files
    if (isTemplate) {
      let content = await fs.readFile(entry, "utf-8");
      content = replaceTemplateVars(content, vars);
      await fs.ensureDir(path.dirname(destPath));
      await fs.writeFile(destPath, content, "utf-8");
    } else {
      await fs.ensureDir(path.dirname(destPath));
      await fs.copyFile(entry, destPath);
    }
  }

  // Also apply template substitution to init.sh (not .hbs but has placeholders)
  const initShPath = path.join(targetDir, "init.sh");
  if (await fs.pathExists(initShPath)) {
    let content = await fs.readFile(initShPath, "utf-8");
    content = replaceTemplateVars(content, vars);
    await fs.writeFile(initShPath, content, "utf-8");
  }

  // Set executable permissions on shell scripts
  const shFiles = (await walkDir(targetDir)).filter((f) => f.endsWith(".sh"));
  for (const sh of shFiles) {
    try {
      fs.chmodSync(sh, 0o755);
    } catch {
      // chmod may not work on Windows, safe to ignore
    }
  }
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

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("create-ralph-loop")
    .description(
      "Scaffold a Ralph agentic automation loop for AI-driven iterative development"
    )
    .argument("[project-directory]", "Directory to create the project in")
    .option("-y, --yes", "Use defaults for all prompts", false)
    .option("--no-git", "Skip git init")
    .option("--no-install", "Skip npm install")
    .action(async (projectDir: string | undefined, options) => {
      // If no directory provided, prompt for it
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

      const targetDir = path.resolve(projectDir!);
      const dirName = path.basename(targetDir);

      // Check if directory already exists and has contents
      if (await fs.pathExists(targetDir)) {
        const contents = await fs.readdir(targetDir);
        if (contents.length > 0) {
          console.error(
            `Error: Directory "${projectDir}" already exists and is not empty.`
          );
          process.exit(1);
        }
      }

      let projectName = dirName;
      let projectDescription = "An AI-powered application";

      if (!options.yes) {
        const answers = await inquirer.prompt([
          {
            type: "input",
            name: "projectName",
            message: "Project name:",
            default: dirName
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c: string) => c.toUpperCase()),
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

      const vars: TemplateVars = {
        projectName,
        projectSlug: toKebabCase(projectName),
        projectDescription,
        createdAt: new Date().toISOString().split("T")[0],
      };

      console.log("");
      console.log(`Creating ${projectName} in ${targetDir}...`);
      console.log("");

      await scaffold(targetDir, vars);

      // Git init
      if (options.git !== false) {
        try {
          execSync("git init", { cwd: targetDir, stdio: "pipe" });
          console.log("Initialized git repository.");
        } catch {
          console.log("Warning: git init failed. You can do this manually.");
        }
      }

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
      console.log(
        '     claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \\'
      );
      console.log(
        '       --allowedTools "Read,Write,Edit,Glob,Grep,Bash"'
      );
      console.log("");
      console.log("  3. Run the Ralph loop:");
      console.log("     ./ralph.sh --claude 20");
      console.log("");
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
