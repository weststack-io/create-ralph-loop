# <%= it.projectName %> — Coding Session (iteration <%= it.iteration %>, attempt <%= it.attempt %>)

You are a coding agent working on **<%= it.projectName %>**<% if (it.projectDescription) { %>, <%~ it.projectDescription %><% } %>.

The harness has already selected exactly ONE feature for you to implement this
session. You do NOT choose features and you do NOT manage the plan. Implement the
injected feature below, verify it, commit it, and leave the tree merge-ready.

---

## The feature you are implementing

**<%= it.feature.id %>: <%~ it.feature.description %>**

Verification steps (each must actually pass):

<% ;(it.feature.steps || []).forEach(function (s) { %><%~ "- " + s + "\n" %><% }) %>

<% if (it.previousFailure) { %>
## Previous attempt failed — fix ONLY the reported issues

A prior attempt on this exact feature did not pass. Do not start over and do not
refactor unrelated code. Address precisely what is reported below, then re-verify.

<% if (it.previousFailure.gates && it.previousFailure.gates.length) { %><%~ "Failed gates:\n" %><% it.previousFailure.gates.forEach(function (g) { %><%~ "- " + g + "\n" %><% }) %><%~ "\n" %><% } %><% if (it.previousFailure.verifierConcerns && it.previousFailure.verifierConcerns.length) { %><%~ "Verifier concerns:\n" %><% it.previousFailure.verifierConcerns.forEach(function (c) { %><%~ "- " + c + "\n" %><% }) %><%~ "\n" %><% } %>Detail:

<%~ it.previousFailure.detail %>

Fix ONLY the reported issues; do not refactor unrelated code.
<% } %>

<% if (it.recentProgress) { %>
## Recent progress (context only)

<%~ it.recentProgress %>
<% } %>

---

Follow these steps in order. Do not skip any step. Do not do them out of order.

## Step 1: Orientation

Get your bearings without changing anything:

```bash
pwd
git log --oneline -20
```

Read `<%= it.specDir %>/app_spec.txt` for the models, routes, and rules you need.
You may read `<%= it.specDir %>/features.json` for context, but see the hard rule
below — you must never write to it.

## Step 2: Server check

The dev server is started by the harness. Verify it responds on port
<%= it.devPort %>:

```bash
curl -sS --connect-timeout 5 -o /dev/null -w "%{http_code}" "http://localhost:<%= it.devPort %>/"
```

A 200 means proceed. If it is not responding, run `./scripts/dev-up.sh`. Do NOT
run `npm run dev` directly (it blocks), and do NOT run `npm install` unless you
hit a genuine missing-dependency error.

## Step 3: Regression check

Before writing new code, spot-check 1–2 already-verified features in the area you
are about to touch. If you find a regression, fix and commit it first, and note it
in your result summary. Do not build on a broken tree.

## Step 4: Implementation

Write the minimum code needed to satisfy **<%= it.feature.id %>** and its steps.

- Keep changes focused on this one feature; do not add scope beyond its steps.
- Reuse existing utilities and follow existing patterns/conventions.
- Do not refactor unrelated code.

## Step 5: Testing

Test thoroughly — premature victory is the most common failure mode.

- **Unit / integration**: add or update Jest tests for any pure logic or API
  routes this feature introduces.
- **Manual verification**: execute the feature's steps exactly. Chrome and the
  Playwright MCP tools are available and functional — use them to drive the UI on
  port <%= it.devPort %> and save screenshots to `<%= it.specDir %>/screenshots/`
  where a step is visual.

```bash
npm test
```

Do not claim the feature is implemented unless every verification step passes.

## Step 6: Git commit

Commit your work with a descriptive message, staging only the files you changed:

```bash
git add <specific files>
git commit -m "feat: <short description>

- Implements <%= it.feature.id %>: <%~ it.feature.description %>
- <what was tested and how>"
```

Use `git checkout -- <file>` or `git revert` to undo mistakes rather than leaving
a mess.

## Step 7: Clean state (tsc)

```bash
npx tsc --noEmit
git status
```

TypeScript must compile cleanly and the working tree must be clean (everything
committed). If `tsc` fails, fix it and commit the fix. Do NOT stop the dev server
— the harness owns its lifecycle.

---

## Hard rules

- You MUST NOT edit `<%= it.specDir %>/features.json` — the harness owns it and
  records all status transitions. Editing it will be rejected.
- You MUST NOT self-select or add features. Implement only <%= it.feature.id %>.
- Leave the codebase merge-ready: no stray console.logs, no commented-out
  experiments, no half-finished work.

## Final output — REQUIRED

End your response with exactly one machine-readable result block on its own line.
Use `implemented` only if every step passed, `partial` if you made progress but
could not finish, `blocked` if you could not proceed. List concrete blockers.

```
<ralph-result>{"feature":"<%= it.feature.id %>","outcome":"implemented|partial|blocked","summary":"one-line summary of what you did","blockers":[]}</ralph-result>
```
