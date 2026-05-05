# create-ralph-loop

Scaffold a [Ralph](https://ghuntley.com/ralph/) agentic automation loop for AI-driven iterative development.

Ralph is a harness that drives Claude (or Codex) through a structured, iterative feature-implementation workflow. You define your specs and feature list, and Ralph loops through them one at a time — implementing, testing, and committing each feature automatically.

## Quick Start

```bash
npx create-ralph-loop my-project
cd my-project
```

Then fill in your specs and run the loop:

```bash
# 1. Write your specs (PRD, app_spec, feature_list)
# 2. Run the initializer once:
claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"

# 3. Run the Ralph loop:
./ralph.sh --claude 20
```

## What You Get

```
my-project/
├── ralph.sh              # Main loop driver (runs N iterations of Claude/Codex)
├── init.sh               # Environment setup (idempotent)
├── scripts/
│   ├── dev-up.sh         # Start dev server in background
│   └── dev-down.sh       # Stop dev server
├── specs/phase1/
│   ├── PRD.md            # Product requirements (you fill this in)
│   ├── app_spec.txt      # Technical specification (you fill this in)
│   ├── feature_list.json # Feature catalog with pass/fail tracking
│   └── prompts/
│       ├── init_prompt.md    # One-time scaffolding instructions
│       └── coding_prompt.md  # 10-step workflow (run each iteration)
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

### 1. Define Your Specs

Before running anything, fill in three key files:

**`specs/phase1/PRD.md`** — What you're building and why. The agent reads this for context but doesn't modify it.

**`specs/phase1/app_spec.txt`** — The technical bible. Data models, API routes, business logic, UI layout. Agents reference this when implementing features.

**`specs/phase1/feature_list.json`** — Every feature your project needs, with:
- `id`: Unique identifier (e.g., `INFRA-001`, `FEAT-001`)
- `priority`: Implementation order (lower = first)
- `category`: Grouping (infrastructure, ui, api, feature, etc.)
- `description`: What the feature does
- `steps`: Verification checklist (acceptance criteria)
- `passes`: `false` initially, flipped to `true` by the agent after verification

### 2. Run the Initializer

The init prompt scaffolds your project from your specs. Run it once:

```bash
claude -p "$(cat specs/phase1/prompts/init_prompt.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash"
```

This creates your Next.js app, database, types, layout, stub routes, and test config.

### 3. Run the Loop

```bash
./ralph.sh --claude 20    # 20 iterations with Claude
./ralph.sh --codex 10     # 10 iterations with Codex
```

Each iteration implements one feature. The loop exits early when all features pass.

### 4. Monitor Progress

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
