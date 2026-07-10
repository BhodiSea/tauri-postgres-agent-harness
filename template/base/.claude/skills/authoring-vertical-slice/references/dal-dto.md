# DAL + DTO + route reference

## The DAL law

`apps/server/src/dal/**` is the ONLY layer that touches the database driver
(postgres.js). Every function body runs inside `withUserContext` from
`apps/server/src/db/context.ts`:

```ts
// db/context.ts (already shipped — reuse, never reimplement)
export async function withUserContext<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // opens a transaction and binds identity transaction-locally:
  //   select set_config('app.user_id', ${userId}, true)
  // FORCE RLS keys on this GUC — the wrapper IS the authorization boundary.
}
```

The write-guard denies whole-file writes to `apps/server/src/dal/*.ts` that lack
`withUserContext`. `DATABASE_URL` is the unprivileged `app_api` role; there is no
code path to the database outside a user context.

## DAL module shape (`apps/server/src/dal/<feature>.ts`)

- Implement an interface declared in `src/types.ts` (the `NotesDal` pattern) so
  routes depend on the contract and tests inject fakes via `createApp({ ... })`.
- Zod-parse at the DAL exit: map the row and `parse` it with the DTO schema from
  `@app/schema` (the `NoteDto` pattern) — raw driver rows never escape. The select
  list matches the DTO exactly; internal columns (e.g. `embedding`) are never
  selected. postgres.js decodes `timestamptz` as `Date`; DTOs carry ISO-8601 strings.
- No app-side owner filtering on reads — visibility is the RLS policies' job, and a
  `WHERE owner_id = ...` would mask a policy regression. On INSERT the owner column
  is `userId` (the verified token subject), never a wire value; the RLS `WITH CHECK`
  rejects anything else with SQLSTATE 42501.
- `noUncheckedIndexedAccess`: `rows[0]` is `T | undefined` — branch on it explicitly.

## Route wiring (`@hono/zod-openapi`)

- Contracts are `createRoute` definitions with request/response schemas imported from
  `@app/schema`; handlers registered via `app.openapi(route, handler)` in
  `apps/server/src/app.ts` (the composition root — new slices may factor their
  `createRoute` definitions into `apps/server/src/routes/<feature>.ts` and register
  from `app.ts`).
- Mount under `/api/*`: the version-skew middleware (409 `{ error: 'version_skew' }`
  on major mismatch) and `requireAuth` (verified JWT → `c.set('userId', ...)`) cover
  exactly that prefix, and a unit test walks the route table to prove coverage.
  `/healthz` and `/openapi.json` are the only routes outside it.
- Auth failures collapse to a bare 401 — never leak why a credential was rejected.
- Protected routes declare `security: [{ Bearer: [] }]` so the contract documents it.
- SSE endpoints use `streamSSE` with `stream.onAbort` stopping the producer — an
  orphaned generator per dropped client is a slow server leak.
  `[corpus: hono/sse-abort]`
- After ANY route change, regenerate the committed contract: `pnpm openapi:emit`
  (stable-stringified `apps/server/openapi.json`; the `contracts` gate re-emits and
  fails on diff).

## Discipline

- `import type` for type-only imports (`verbatimModuleSyntax`); no non-null
  assertions on user data; sonarjs cognitive-complexity ≤ 15 is a lint ERROR —
  refactor, never suppress.
- `// SOURCE: <authority> [corpus: <id>]` on every non-trivial decision — the
  provenance gate flags unsourced decision keywords (jwtVerify, timeouts, retries,
  set_config, ...).
