# create-ralph-loop

Scaffold a **[Ralph Loop](https://github.com/weststack-io/create-ralph-loop)** autonomous-build harness into a new or existing project. Writes a thin config + specs and wires up the [`ralph-loop`](https://www.npmjs.com/package/ralph-loop) runtime — the guardrailed loop that builds toward an outcome for you.

## Quick start

```bash
# New project
npx create-ralph-loop my-app
cd my-app && npm install                 # installs the ralph-loop runtime

npx ralph plan --idea "a habit tracker with streaks"   # generate specs
npx ralph doctor
npx ralph run --budget 20                # build until done, $20 cap
```

## What it scaffolds

```
my-app/
├── ralph.config.json      # roles/models, gates, budgets, verify, dev server ($schema-validated)
├── AGENTS.md              # concise table-of-contents into docs/ (golden principles, loop overview)
├── CLAUDE.md              # @AGENTS.md
├── docs/                  # knowledge-base skeleton (design/, plans/, tech-debt.md)
├── specs/phase1/
│   ├── PRD.md             # product requirements (fill in, or `ralph plan`)
│   ├── app_spec.txt       # technical spec
│   └── features.json      # v2 feature contract (dependency-minimized seed)
├── .mcp.json              # Playwright MCP for browser verification
├── .env.example
└── .gitignore             # includes .ralph/ (runtime state)
```

No bash loop scripts — the `ralph-loop` runtime owns the loop and dev-server lifecycle cross-platform.

## Existing projects

```bash
cd my-existing-app
npx create-ralph-loop --adopt            # detects framework/package-manager/dev+test/port
npx ralph migrate                        # if upgrading from a v1 (feature_list.json + ralph.sh)
```

Adoption layers Ralph files in without touching your app code: it merges `ralph-loop` into `devDependencies`, deep-merges `.mcp.json`, appends delimited sections to `CLAUDE.md`/`AGENTS.md`, and feeds detection results into the generated `ralph.config.json` (dev command, port, test gate).

## Options

```
Usage: create-ralph-loop [options] [project-directory]

  -y, --yes         Use defaults for all prompts
  --no-git          Skip git init (greenfield)
  --no-install      Skip dependency install (adopt)
  --adopt, --init   Adopt into an existing project
  -h, --help
```

## Requirements

Node ≥ 18, git, and an agent CLI (`claude`, `codex`, or `aider`) for running the loop. See the [`ralph-loop`](https://www.npmjs.com/package/ralph-loop) runtime for loop details.

## License

MIT
