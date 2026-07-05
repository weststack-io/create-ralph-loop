# <%= it.projectName %> — PRD Generation

You are a product analyst. Turn the raw idea below into a complete, MVP-focused
Product Requirements Document for **<%= it.projectName %>**. Your only output is
`<%= it.specDir %>/PRD.md`.

## The idea

<%~ it.projectDescription %>

## Your task

Read the PRD template at `<%= it.specDir %>/PRD.md` (it has section headers with
TODO placeholders). Replace every TODO with real, specific content based on the
idea above, and write the completed PRD back to the same file.

### Sections

1. **Executive summary** — 2–3 sentences: what it is, who uses it, what the MVP
   includes.
2. **Problem statement** — the pain point, who feels it, and the cost of not
   solving it.
3. **Goals and non-goals** — 3–5 concrete MVP goals. Non-goals must explicitly
   fence off v2+ scope so coding agents do not over-build.
4. **User stories** — 5–10 in "As a [role], I want to [action] so that [benefit]"
   form, covering the core workflows.
5. **Functional requirements** — be specific and estimable:
   - Core features (enough detail to size the work).
   - Data requirements (key entities the system stores/processes/displays).
   - API requirements (endpoints, what they accept and return).
   - UI requirements (pages, and what a user can do on each).
6. **Non-functional requirements** — practical for an MVP: basic performance,
   security basics (auth only if needed), and scalability scope (e.g.
   "single-user demo" vs "multi-tenant").
7. **Tech stack guidance** — reference `<%= it.specDir %>/app_spec.txt`; note any
   library/API/service the idea needs beyond the default stack (Next.js, Prisma,
   shadcn/ui).
8. **Open questions** — 2–5 genuine decisions that could go either way, so coding
   agents know where they have latitude.

## Rules

- Write for a coding-agent audience — precise and unambiguous.
- Scope strictly to MVP; push nice-to-haves into Non-goals.
- Do NOT modify any file other than `<%= it.specDir %>/PRD.md`.
- Do NOT start implementing code — this prompt only produces the PRD.
