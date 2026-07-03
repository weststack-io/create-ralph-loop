# Ralph Loop

An optimized, codified harness for **autonomous software building**. You describe an outcome; a guardrailed loop of AI coding agents builds toward it — checkpointing, running mechanical gates, verifying its own work with an independent model, tracking cost, and supervising itself — so you supervise by exception instead of eyeballing every iteration.

This is a ground-up v2 of the original [Ralph](https://ghuntley.com/ralph/) technique (a stateless coding agent re-run in a loop against a feature list). The 55-line bash driver is gone; the orchestrator is now a cross-platform TypeScript runtime with real guardrails.

## Packages

| Package | What it is |
|---|---|
| [`ralph-loop`](packages/ralph) | The runtime CLI (`ralph`). Owns the loop, adapters, gates, verifier, budgets, telemetry. |
| [`create-ralph-loop`](packages/create-ralph-loop) | Scaffolder. Writes a thin config + specs into a new or existing project. |

## Quick start

```bash
# 1. Scaffold (new project)
npx github:weststack-io/create-ralph-loop my-app
cd my-app && npm install            # installs the ralph-loop runtime

# 2. Generate specs from an idea (uses the planner model)
npx ralph plan --idea "a habit-tracking PWA with streaks and reminders"

# 3. Check the setup, then run the autonomous loop
npx ralph doctor
npx ralph run --budget 20           # build until done, $20 cost cap
```

Watch progress with `ralph status`; supervise by exception via desktop/webhook notifications.

## How the loop works (v2)

Each iteration is a state machine the **harness** drives — success is never self-graded:

```
select next DAG-eligible feature   ← harness picks it (agent no longer self-selects)
      │
   git checkpoint  (known-good commit to revert to)
      │
   coder agent  →  implements ONE feature, emits a <ralph-result> block
      │
   mechanical gates  (harness runs them, not the agent):
      · featureIntegrity — features.json is harness-owned; edits are rejected
      · diff size        — sanity bound on churn
      · typecheck/test/build — baseline-relative: only NEW failures block
      │
   independent verifier  (fresh context, cheaper model, fail-closed)
      │
   ┌── all pass ─→ commit (code + status) atomically, feature = verified
   └── any fail ─→ git reset --hard to checkpoint; retry (bounded) → block
      │
   budgets · stall detection · periodic replan · periodic gardening
```

Guardrails, all mechanical:

- **Checkpoint + auto-revert.** A failed gate or verdict hard-reverts the iteration. No half-finished work survives.
- **Independent, fail-closed verification.** A separate context (ideally a different/cheaper model) re-checks every claimed pass by executing the feature's steps. Ambiguous or unparseable → treated as failure.
- **Baseline-relative gates.** Pre-existing test/type failures are tolerated; only failures your change *introduces* block it.
- **Bounded retries → block.** After `retries.maxAttempts`, a feature is marked blocked (with the reason) and the loop moves on instead of thrashing.
- **Budgets + stall detection.** Cost / iteration / wall-clock caps halt the run; lack of progress notifies and eventually halts.
- **Periodic self-improvement.** A strong model reviews the plan and git history and may reprioritize / block / unblock / split / prune / add dependencies (`replan.everyIterations`). A "gardener" pass periodically cleans entropy/"AI slop" (`garden.everyIterations`).
- **Structured telemetry.** Every event lands in `.ralph/progress.jsonl`; per-role token/cost accounting in `.ralph/run-state.json`.

## Model routing

Roles are mapped to (adapter, model, permission tier) in `ralph.config.json`. The shipped default routes a strong model to planning, a capable coder to building, and a cheap model to verification (validated by Aider's Architect/Editor split and RouteLLM):

```jsonc
"roles": {
  "coder":     { "adapter": "codex",  "permissionTier": "full" },
  "verifier":  { "adapter": "claude", "model": "claude-haiku-4-5-20251001", "permissionTier": "readonly" },
  "planner":   { "adapter": "claude", "model": "claude-fable-5", "permissionTier": "edit" },
  "replanner": { "adapter": "claude", "model": "claude-fable-5", "permissionTier": "readonly" }
}
```

Adapters are pluggable (`claude`, `codex`, `aider`). Cross-vendor coder/verifier is a recommended diversity win.

### Local LLMs

Use the `aider` adapter with a local model — the coder runs offline while a cheap hosted verifier keeps the fail-closed safety:

```jsonc
"coder": { "adapter": "aider", "model": "ollama/qwen2.5-coder", "permissionTier": "full" }
```

## Commands

```
ralph run [--iterations N] [--budget USD] [--no-verify] [--fresh]
ralph plan [--idea "..."] [--prd-only]     generate PRD / app_spec / features.json
ralph dev up | down | status               dev-server lifecycle (cross-platform)
ralph doctor                               diagnose adapters / git / config / DAG
ralph status                               summarize the latest run
ralph migrate                              upgrade a v1 project (feature_list.json + ralph.sh)
ralph export --format eval-jsonl           verification records for offline eval
```

## Migrating from v1

```bash
cd my-old-ralph-project
npx ralph migrate     # feature_list.json → features.json v2, writes ralph.config.json,
                      # parks the old bash scripts under .ralph/legacy/
npx ralph doctor
```

## Requirements

- **Node.js** ≥ 18
- **git**
- At least one agent CLI on PATH: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [aider](https://aider.chat) (for local models)
- **No bash required** — the runtime is native TypeScript and works on Windows, macOS, and Linux.

## Development

```bash
npm install
npm run build      # builds both packages + generates the config JSON schema
npm test           # vitest: unit + a real-git mock-adapter e2e suite
```

## Design provenance

The guardrail design is grounded in published practice: OpenAI's harness-engineering report (Ralph loops at production scale; verification externalized into the environment; recurring "gardening" agents against entropy), the hermes-agent/Nightwire fail-closed independent-verification pattern (separate context, baseline-relative regressions, bounded self-heal), Anthropic's multi-agent cost/coordination guidance (effort scaling, max-iteration + escalation), and Aider Architect/Editor + RouteLLM for criticality-based model routing.

## License

MIT
