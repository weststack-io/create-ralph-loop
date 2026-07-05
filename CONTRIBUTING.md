# Contributing

Thanks for working on Ralph Loop. This is an npm-workspaces monorepo with two
published packages and a shared test suite.

## Layout

```
packages/
├── ralph/                 # ralph-loop — the runtime CLI (the product)
│   ├── src/               # module map below
│   ├── assets/prompts/    # default agent prompts (eta templates)
│   ├── schema/            # generated JSON schema for ralph.config.json
│   └── scripts/gen-schema.ts
└── create-ralph-loop/     # the scaffolder
    ├── src/cli.ts
    └── template/          # what gets written into a scaffolded project
e2e/                       # real-git, mock-adapter end-to-end loop tests
```

## Dev workflow

```bash
npm install
npm run build      # tsc for both packages + regenerates schema/ralph.config.schema.json
npm test           # vitest: unit suites + the e2e loop suite
npm run test:watch
```

- **Node ≥ 18, CommonJS.** Use normal imports (no `.js` extensions) and `node:`-prefixed builtins.
- **Never spawn processes directly.** Go through `packages/ralph/src/util/proc.ts`
  (`run`, `runShell`, `spawnDetached`, `commandExists`, `killTree`). It uses
  cross-spawn for argv spawns (Windows `.cmd` resolution) and Node's native spawn
  for shell commands (cross-spawn misreports shell exit code 1 as ENOENT on Windows).
- **Validate external/parsed data with zod; fail closed.** Unparseable agent
  output must never throw — degrade to a rejecting outcome.
- Prompts render with **eta** (`<%= it.x %>`), not handlebars, despite the history.

## Module map (`packages/ralph/src`)

| Area | Files | Responsibility |
|---|---|---|
| Foundation | `config/schema.ts`, `features/schema.ts`, `adapters/types.ts`, `events/types.ts` | zod schemas + shared type contracts (imported everywhere). |
| Adapters | `adapters/{claude,codex,aider,mock,registry}.ts` | Wrap agent CLIs behind `RunnerAdapter`. |
| Gates | `gates/{baseline,command,featureIntegrity,diffSize,index}.ts` | Mechanical checks over a `GateContext`. |
| Features | `features/{store,dag,migrate}.ts` | Harness-owned feature state, DAG selection, v1→v2 migration. |
| Dev server | `devserver/manager.ts` | Cross-platform dev-server lifecycle. |
| Prompts | `prompts/{render,blocks}.ts` | Template resolution + `<ralph-*>` block parsing. |
| Verify / replan / garden | `verify/verifier.ts`, `replan/replanner.ts`, `garden/gardener.ts` | The three supporting agent roles. |
| Run | `run/{loop,iteration,checkpoint,state,types}.ts` | The orchestrator state machine. |
| Support | `budget/tracker.ts`, `notify/`, `events/log.ts`, `util/*` | Budgets, notifications, telemetry, proc/git/paths/logger. |
| CLI | `cli.ts` | `commander` wiring; assembles the `RunContext`. |

The **loop is the only consumer** of most modules, so a subagent implementing one
module only needs the foundation types — the loop reconciles them.

## Recipe: add a runner adapter

1. Create `packages/ralph/src/adapters/<name>.ts` exporting a class that
   implements `RunnerAdapter` (`adapters/types.ts`): `name`, `isAvailable()`
   (via `commandExists`), and `invoke(req)` returning an `AgentResult`.
   - Build argv, pass the prompt via `run(..., { input })` (stdin) to avoid
     argv-length limits.
   - Map `req.permissionTier` (`readonly`/`edit`/`full`) to the CLI's own flags.
   - Extract token/cost into `usage` when the CLI reports it; return `usage:
     undefined` otherwise (the loop falls back to iteration/time budgets).
   - Keep parsing in an exported pure function and unit-test it against a fixture.
2. Register it in `adapters/registry.ts` (`getAdapter` switch).
3. It's now selectable via any role in `ralph.config.json` (`"adapter": "<name>"`).

## Recipe: add a gate

1. Create `packages/ralph/src/gates/<name>.ts` exporting a class implementing
   `Gate` (`gates/types.ts`): `name` + `run(ctx: GateContext): GateResult`.
   Gates are git-pure — read only from `ctx` (`changedFiles`, `diffStat`,
   `featuresHash*`, `baseline`); only command gates spawn a subprocess (via
   `runShell`). For baseline-relative behavior, compare current failures to
   `ctx.baseline` and block only on new signatures.
2. Wire it into `buildGates()` in `gates/index.ts` (respect a config toggle).
3. Add a colocated `*.test.ts`.

## Recipe: change a prompt

Defaults live in `packages/ralph/assets/prompts/*.md` (eta). A project can
override any of them at `<specDir>/prompts/<name>.md` — `prompts/render.ts`
prefers the override. If you add a template that emits a structured block, add a
`parse*` function + zod schema in `prompts/blocks.ts` (fail-closed).

## Testing

- **Unit:** colocated `*.test.ts` next to each module. Run one file with
  `npx vitest run <path>` (esbuild transpiles per-file; no full build needed).
- **End-to-end:** `e2e/loop.e2e.test.ts` drives `runLoop` with the `MockAdapter`
  against a real temp git repo — the reference for how the pieces compose
  (happy path, gate/verifier failure + revert + retry + block, integrity tamper,
  dependency ordering, replan). Add scenarios here when changing loop behavior.
- CI runs `build` + `test` on ubuntu **and** windows; keep both green.

## Commits & PRs

- Conventional-commit prefixes (`feat(ralph):`, `fix:`, `docs:`, `chore:`).
- Branch off `main`; open a PR. CI must pass on both OSes.
