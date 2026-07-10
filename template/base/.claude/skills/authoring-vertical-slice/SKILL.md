---
name: authoring-vertical-slice
description: >
  The migration -> RLS -> DAL -> route -> desktop feature -> test recipe for shipping
  one whole feature slice through the Tauri 2 + Hono + Postgres monorepo in a single
  turn. Use when asked to add a feature, endpoint, or screen end-to-end.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
argument-hint: "[feature-name]"
---

# Authoring a vertical slice

Build the slice in this strict order. Each layer has a lazy reference file — read it
before writing that layer (progressive disclosure keeps context lean). Delegate
non-trivial layers to the named subagent.

1. **Migration + RLS** — read `references/migration-rls.md`. Drizzle schema in
   `packages/schema/src/` (pgTable + four per-op pgPolicy + `.enableRLS()`); the SQL
   migration is written ONCE as a new `packages/schema/drizzle/NNNN_<feature>.sql`
   (append-only — existing migrations can never be edited) carrying ENABLE + FORCE
   ROW LEVEL SECURITY, the four initPlan policies, and the GRANT to `app_api`, plus
   its `meta/_journal.json` entry. Delegate to the `migration-rls-author` subagent.
2. **DAL + DTO** — read `references/dal-dto.md`. Module at
   `apps/server/src/dal/<feature>.ts`; every function inside
   `withUserContext(userId, ...)` (the SET LOCAL authorization boundary — the
   write-guard requires it); return Zod-parsed DTOs from `@app/schema`, never raw
   driver rows. Delegate to the `dal-author` subagent.
3. **Route + contract** — same reference. `createRoute` contracts from
   `@hono/zod-openapi` registered in `apps/server/src/app.ts`, mounted under `/api/*`
   (skew + auth middleware). Then the MAIN THREAD regenerates the committed contract:
   `pnpm openapi:emit` (the `contracts` gate diffs `apps/server/openapi.json`).
4. **Desktop feature** — read `references/desktop-feature.md`. Feature dir at
   `apps/desktop/src/features/<feature>/`; typed fetch via `@app/schema` contracts;
   shortcuts declared in `src/keyboard/registry.ts` (WCAG 2.1.4 registry rule);
   connection-aware UI (degrade when `/healthz` is unreachable); no `@tauri-apps/*`
   imports outside `src/ipc/**` + `src/keyboard/**`.
5. **Tests** — read `references/tests.md`. Add the `IsolationTarget` in
   `tests/rls/db-context.ts`, unit tests in the right vitest project (unit-node /
   unit-dom), fast-check for any parser. Delegate to the `test-author` subagent.
6. **Provenance (REQUIRED — not optional)** — every non-trivial decision gets
   `// SOURCE:` (`--` in SQL), ideally `[corpus: <id>]`. Then, in this order:
   (a) emit the ADR via `/adr <feature>` so `docs/adr/<YYYYMMDD>-<feature>.md` exists
   and its Sources list reconciles with the inline citations; (b) run
   `/verify-citations` and require `CITATIONS: CLEAN`. Provenance is INCOMPLETE — and
   you may not advance to step 7 — until BOTH the ADR file exists AND citations are
   CLEAN.
7. **Gate** — finish only when the step-6 ADR exists, `/verify-citations` is CLEAN,
   and `pnpm validate`, `pnpm test:rls`, and `pnpm test` are green. The Stop hook
   runs the same steps directly (`node tools/validate.mjs`,
   `node tests/rls/run-rls.mjs`, vitest); do not stop on a red build or with
   provenance incomplete.

## Scaffold

The MAIN THREAD scaffolds the empty skeleton (the `dal-author` subagent has no Bash):

```
node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs <feature>
```

`<feature>` is a single kebab-case argument (e.g. `release-notes`). The script is
idempotent: it writes a file only if it does not already exist. It deliberately does
NOT create the migration file — `packages/schema/drizzle/*.sql` is append-only (the
write-guard denies edits to existing migrations), so a pre-created stub could never
be filled in. Compose the migration completely, write it once.

## IP boundary

Keep reusable platform abstractions separate from bespoke feature code. Never bake
customer content into shared modules.
