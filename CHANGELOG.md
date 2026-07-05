# Changelog

## v2.0 — Codified autonomous harness

Ground-up rewrite of the Ralph technique from a 55-line bash driver into a
cross-platform TypeScript runtime with mechanical guardrails. Split into two
packages: **`ralph-loop`** (the `ralph` runtime CLI) and **`create-ralph-loop`**
(the scaffolder, bumped to 2.0).

### Added

- **Guardrailed run loop** (`ralph run`): per-iteration `checkpoint → coder →
  mechanical gates → independent verifier → accept-commit or hard-revert`.
- **Mechanical gates** run by the harness: `featureIntegrity` (features.json is
  harness-owned), diff-size, and baseline-relative typecheck/test/build (only new
  failures block).
- **Independent, fail-closed verifier** — a fresh context on a cheaper model
  confirms every claimed pass; success is no longer self-graded.
- **Budgets** (cost / iteration / wall-clock) and **notifications** (webhook +
  desktop); structured telemetry in `.ralph/progress.jsonl` and
  `.ralph/run-state.json`.
- **Periodic replan** (strong-model DAG revision) and **gardener** (entropy
  cleanup) passes.
- **Multi-model routing** via role → (adapter, model, permission tier); adapters
  for `claude`, `codex`, and `aider` (**local LLMs** via `ollama/…`).
- **features.json v2** with `depends_on` / `status` / `attempts` / `verification`
  and dormant `lease` fields; DAG-aware selection; dependency-minimized planning.
- New CLI: `ralph plan | dev | doctor | status | migrate | export`.
- `ralph.config.json` with a published JSON schema; GitHub Actions CI
  (ubuntu + windows).

### Changed

- Orchestration is native TypeScript — **no bash required** (first-class Windows).
- Scaffolder emits a thin config + specs (templating moved to eta); the loop
  updates via a version bump instead of re-scaffolding.
- Completion is now "all features verified" (the unused `<promise>COMPLETE
  </promise>` sentinel is gone).

### Removed

- Shipped `ralph.sh` / `init.sh` / `scripts/dev-*.sh` and the duplicated
  adopt-mode script string literals — replaced by the runtime.

### Migrating from v1

```bash
npx ralph migrate   # feature_list.json → features.json v2, writes ralph.config.json,
                    # parks old bash scripts under .ralph/legacy/
```

### Deferred

- Multi-framework greenfield template packs (the runtime is already
  framework-agnostic via configurable `devServer.command` and gates).
