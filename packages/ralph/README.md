# ralph-loop

The runtime for the **Ralph Loop** autonomous software-building harness — a cross-platform TypeScript CLI (`ralph`) that drives AI coding agents toward an outcome with real, mechanical guardrails. You supervise by exception instead of eyeballing every iteration.

> Scaffold a project with [`create-ralph-loop`](https://www.npmjs.com/package/create-ralph-loop), or add this runtime to an existing one.

## Install

```bash
npm i -D ralph-loop
npx ralph doctor      # verify adapters / git / config / feature DAG
npx ralph run         # start the autonomous loop
```

Requires Node ≥ 18, git, and at least one agent CLI on PATH (`claude`, `codex`, or `aider`). **No bash required** — native on Windows, macOS, and Linux.

## How the loop works

Each iteration is a state machine the harness drives — success is never self-graded:

```
select next DAG-eligible feature   ← the harness picks it, not the agent
   │  git checkpoint (known-good commit)
   │  coder agent → implements ONE feature, emits <ralph-result>
   │  mechanical gates (run by the harness):
   │     · featureIntegrity — features.json is harness-owned; edits rejected
   │     · diff size · baseline-relative typecheck/test/build (only NEW failures block)
   │  independent verifier (fresh context, cheaper model, fail-closed)
   ├── all pass → commit code + status atomically → feature = verified
   └── any fail → git reset --hard to checkpoint → retry (bounded) → block
   │  budgets · stall detection · periodic replan · periodic gardening
```

Guardrails, all mechanical:

- **Checkpoint + auto-revert** — failed gates/verdict hard-revert the iteration; no half-finished work survives.
- **Independent fail-closed verification** — a separate context re-executes each feature's steps; unparseable/ambiguous → treated as failure.
- **Baseline-relative gates** — pre-existing test/type failures are tolerated; only failures your change *introduces* block it.
- **Bounded retries → block** — after `retries.maxAttempts`, a feature is blocked (with reason) and the loop moves on.
- **Budgets + notifications** — cost / iteration / wall-clock caps halt the run; webhook + desktop sinks.
- **Periodic self-improvement** — a strong model may reprioritize/block/unblock/split/prune/add-dependency (`replan.everyIterations`); a gardener pass cleans entropy/"AI slop" (`garden.everyIterations`).
- **Structured telemetry** — every event in `.ralph/progress.jsonl`; per-role token/cost in `.ralph/run-state.json`.

## Configuration

`ralph.config.json` (validated against the shipped JSON schema at `ralph-loop/schema/ralph.config.schema.json`). Roles map to `(adapter, model, permission tier)`:

```jsonc
{
  "specDir": "specs/phase1",
  "roles": {
    "coder":     { "adapter": "codex",  "permissionTier": "full" },
    "verifier":  { "adapter": "claude", "model": "claude-haiku-4-5-20251001", "permissionTier": "readonly" },
    "planner":   { "adapter": "claude", "model": "claude-fable-5", "permissionTier": "edit" },
    "replanner": { "adapter": "claude", "model": "claude-fable-5", "permissionTier": "readonly" }
  },
  "gates":  { "typecheck": { "command": "npx tsc --noEmit" }, "test": { "command": "npm test", "baselineRelative": true }, "diff": { "maxFiles": 40, "maxLines": 3000 } },
  "retries": { "maxAttempts": 2 },
  "budgets": { "maxCostUsd": 25, "maxIterations": 50 },
  "verify":  { "enabled": true, "unlockOn": "verified" },
  "devServer": { "command": "npm run dev", "port": 3000, "readinessPath": "/" }
}
```

### Local LLMs

Route the coder to a local model via the `aider` adapter while keeping a cheap hosted verifier for fail-closed safety:

```jsonc
"coder": { "adapter": "aider", "model": "ollama/qwen2.5-coder", "permissionTier": "full" }
```

## Commands

```
ralph run [--iterations N] [--budget USD] [--no-verify] [--fresh]
ralph plan [--idea "..."] [--prd-only]     generate PRD / app_spec / features.json
ralph dev up | down | status               dev-server lifecycle
ralph doctor                               diagnose adapters / git / config / DAG
ralph status                               summarize the latest run
ralph migrate                              upgrade a v1 project (feature_list.json + ralph.sh)
ralph export --format eval-jsonl           verification records for offline eval
```

## Programmatic use

The package also exports the config and feature schemas for tooling:

```ts
import { RalphConfigSchema, FeatureFileSchema } from "ralph-loop";
```

## License

MIT · Part of [weststack-io/create-ralph-loop](https://github.com/weststack-io/create-ralph-loop).
