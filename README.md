# create-ralph-loop

Scaffold a [Ralph](https://ghuntley.com/ralph/) agentic automation loop for AI-driven iterative development.

Ralph is a harness that drives Claude (or Codex) through a structured, iterative feature-implementation workflow. You describe your idea, the agents generate your specs and feature list, then Ralph loops through them one at a time — implementing, testing, and committing each feature automatically.

## Quick Start

```bash
npx github:weststack-io/create-ralph-loop my-project
cd my-project
```

Then describe your idea and let the agents do the rest:

```bash
# 1. Edit specs/phase1/PRD.md with your idea (or generate it):
claude -p "$(cat specs/phase1/prompts/prd_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"

# 2. Generate specs, feature list, and scaffold the project:
claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"

# 3. Run the Ralph loop:
./ralph.sh --claude 20
```

## Demo

Watch the full walkthrough of using the Ralph loop to build a working app from scratch:

[![Watch on YouTube](https://img.shields.io/badge/YouTube-Watch%20Walkthrough-red?logo=youtube)](https://youtu.be/InIwg8_B-2U?si=iydzSiO9k3KKZv2n)

The demo app built in that video is available here: [weststack-io/tether](https://github.com/weststack-io/tether)

## What You Get

```
my-project/
├── ralph.sh              # Main loop driver (runs N iterations of Claude/Codex)
├── init.sh               # Environment setup (idempotent)
├── scripts/
│   ├── dev-up.sh         # Start dev server in background
│   └── dev-down.sh       # Stop dev server
├── specs/phase1/
│   ├── PRD.md            # Product requirements (generated from your idea)
│   ├── app_spec.txt      # Technical specification (generated from PRD)
│   ├── feature_list.json # Feature catalog with pass/fail tracking (generated from PRD)
│   └── prompts/
│       ├── prd_prompt.md      # Generates PRD from your idea
│       ├── init_prompt.md     # Generates specs + scaffolds the project
│       └── coding_prompt.md   # 10-step workflow (run each iteration)
├── progress.txt          # Session log (appended by the agent)
├── CLAUDE.md             # Claude Code project instructions
├── AGENTS.md             # Agent behavior rules
├── .mcp.json             # Playwright MCP for browser testing
├── .env.example          # Environment variable template
└── .gitignore
```

## How the Ralph Loop Works

```
ralph.sh [--claude|--codex] <iterations>
    │
    ├─→ dev-down.sh          (kill any stale server)
    ├─→ init.sh              (npm install, prisma, .env)
    ├─→ dev-up.sh            (start dev server, wait for ready)
    │
    └─→ FOR i=1 TO N:
       │
       ├─→ Feed coding_prompt.md to Claude/Codex
       │   │
       │   ├─ Step 1:  Orient (read progress, features, git log)
       │   ├─ Step 2:  Verify dev server is up
       │   ├─ Step 3:  Regression check existing features
       │   ├─ Step 4:  Pick next unfinished feature by priority
       │   ├─ Step 5:  Implement
       │   ├─ Step 6:  Test (Jest + Playwright)
       │   ├─ Step 7:  Mark feature as passing
       │   ├─ Step 8:  Append progress notes
       │   ├─ Step 9:  Git commit
       │   └─ Step 10: Verify clean state (tsc, git status)
       │
       └─→ Exit early if <promise>COMPLETE</promise> found
```

## The Workflow

### 1. Create Your Project

```bash
npx github:weststack-io/create-ralph-loop my-project
cd my-project
```

This scaffolds the Ralph loop structure with prompts, scripts, and template spec files.

### 2. Generate the PRD

Before running the PRD prompt, edit the project description at the top of `specs/phase1/prompts/prd_prompt.md` with a detailed description of your idea. The more detail you provide, the better the output. Then run:

```bash
claude -p "$(cat specs/phase1/prompts/prd_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"
```

This generates a complete `specs/phase1/PRD.md` with requirements, user stories, and feature scope.

Review the PRD and edit it if anything is off before moving on.

### 3. Generate Specs and Scaffold

```bash
claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"
```

This does three things in one pass:
1. **Generates `app_spec.txt`** — data models, API routes, business logic, UI layout — all derived from your PRD
2. **Generates `feature_list.json`** — a prioritized list of features with verification steps, all marked `passes: false`
3. **Scaffolds the project** — Next.js app, database, types, layout, stub routes, test config, and initial git commit

### 4. Run the Loop

```bash
./ralph.sh --claude 20    # 20 iterations with Claude
./ralph.sh --codex 10     # 10 iterations with Codex
```

Each iteration implements one feature. The loop exits early when all features pass.

### 5. Monitor Progress

- **`progress.txt`** — Read the session log to see what was done
- **`specs/phase1/feature_list.json`** — Check which features have `"passes": true`
- **`git log`** — Each feature gets its own commit

## CLI Options

```
Usage: create-ralph-loop [options] [project-directory]

Options:
  -y, --yes       Use defaults for all prompts
  --no-git        Skip git init
  --no-install    Skip npm install
  -h, --help      Display help
```

## Requirements

- **Node.js** >= 18 (v24 LTS recommended)
- **npm**
- **git**
- **[Claude CLI](https://docs.anthropic.com/en/docs/claude-code)** or **[Codex CLI](https://github.com/openai/codex)**
- **Bash shell** (native on macOS/Linux, Git Bash or WSL on Windows)

## License

MIT
