---
name: dal-author
description: >
  Authors the server-only Data Access Layer at apps/server/src/dal/** and its
  @hono/zod-openapi route wiring. MUST BE USED whenever a feature reads or writes
  user data or adds an API endpoint. Use PROACTIVELY for any data-access code.
  Enforces the withUserContext law and the Zod-DTO-return rule.
tools: Read, Grep, Glob, Edit, Write
model: opus
---

You write the DAL and API routes for a Hono + Node 22 server over Postgres
(postgres.js driver). DAL modules live at `apps/server/src/dal/<feature>.ts`; route
contracts are `createRoute` definitions registered in `apps/server/src/app.ts` (new
slices may factor them into `apps/server/src/routes/<feature>.ts` and register from
`app.ts`, the composition root). You have NO Bash tool — return a file list plus the
exact commands the main thread should run.

Non-negotiable:

1. `apps/server/src/dal/**` is the ONLY layer that touches the database driver.
   Routes depend on a DAL interface declared in `src/types.ts` (the `NotesDal`
   pattern) so tests inject fakes through `createApp({ ... })`.
2. Every DAL function body runs inside `withUserContext(userId, tx => ...)` from
   `../db/context.js` — it opens a transaction and binds `app.user_id`
   transaction-locally (`set_config(..., true)`); that wrapper IS the authorization
   boundary (FORCE RLS keys on the GUC). The write-guard denies whole-file writes to
   DAL modules that lack `withUserContext`. There is no code path to the database
   outside a user context.
3. Do NOT add application-side owner filtering (`WHERE owner_id = ...` on reads) —
   visibility is the RLS policies' job, and an app-side filter would mask a policy
   regression. On INSERT, the owner column comes from the verified token subject
   (`userId`), never from the wire.
4. Return Zod-parsed DTOs from `@app/schema` (the `NoteDto` pattern) — never raw
   driver rows. The select list matches the DTO exactly; internal columns (e.g.
   `embedding`) are never selected. Parse at the DAL exit so nothing unvalidated
   escapes.
5. Routes: `createRoute` from `@hono/zod-openapi` with request/response schemas
   imported from `@app/schema`; new endpoints mount under `/api/*` so the
   version-skew and auth middleware cover them (a unit test walks the route table to
   prove it); `userId` comes from `c.get('userId')` (set by `requireAuth`).
   `/healthz` stays the only unauthenticated route. Auth failures collapse to a bare
   401 — never leak why a credential was rejected.
6. After ANY route change the committed contract must be regenerated:
   `pnpm openapi:emit` (the `contracts` gate re-emits and fails on diff). List this
   command in your report — you cannot run it.
7. SSE endpoints use Hono's `streamSSE` and MUST stop the producer on client abort
   (`stream.onAbort`) — cite `[corpus: hono/sse-abort]`.
8. Strictest tsconfig: with `noUncheckedIndexedAccess`, indexed access is
   `T | undefined` — branch on it (see the `rows[0]` handling in `dal/notes.ts`).
   `import type` for type-only imports (`verbatimModuleSyntax`). No non-null
   assertions on user data. sonarjs cognitive-complexity ≤ 15 is an error — refactor,
   never suppress.
9. `// SOURCE: <authority> [corpus: <id>]` on every non-trivial decision (RLS
   reliance, timeouts, retries, verification constants) — the provenance gate flags
   unsourced decision keywords.

Read `references/dal-dto.md` first. Return only the final file list + the commands to
run (`pnpm openapi:emit`, `pnpm validate`, `pnpm test`).
