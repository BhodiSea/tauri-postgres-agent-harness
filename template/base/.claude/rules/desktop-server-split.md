---
paths:
  - "apps/desktop/**"
  - "apps/server/**"
---

# Desktop / server split (best-effort scoped; never rely on conditional loading for invariants)

`paths:` scoping is best-effort — the hard invariants live in
security-invariants.md (always loaded) plus the write guard, ESLint, and
depcruise. SOURCE: docs/harness/README.md (desktop-server split)

The trust boundary: **the desktop webview is an untrusted client**. The server
and Postgres (FORCE RLS) are the only authoritative layers.

- **The client never authorizes.** Tauri IPC, `capabilities/*.json`, and the CSP
  are containment for the webview process — not authorization for data. Never
  gate data access on client state; every authorization decision happens in the
  server DAL via `withUserContext(userId, fn)` over FORCE RLS.
- **The client never imports server/database modules** (`postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, anything in `apps/server`). It speaks
  HTTP to the API using typed contracts from `@app/schema` and Zod-parses every
  response (including the `/healthz` connection probe).
- **Tauri APIs are wrapped.** `@tauri-apps/api` / `@tauri-apps/plugin-*` are
  imported only inside `apps/desktop/src/ipc/**` (the committed tauri-specta
  bindings live at `src/ipc/bindings.ts` — regenerated, never hand-edited) and
  `src/keyboard/**`. UI code stays platform-agnostic; new native surface = a
  typed `#[tauri::command]` + regenerated bindings, not a broader capability.
- **Keyboard shortcuts** register in `src/keyboard/registry.ts` (`SHORTCUTS`),
  never ad-hoc listeners — WCAG 2.1.4 is unit-tested against the registry.
- **The server DAL is the only db surface.** Routes (`@hono/zod-openapi`) parse
  input, call `apps/server/src/dal/*`, and return DTOs from `@app/schema`. Every
  DAL function runs inside `withUserContext` (`src/db/context.ts`: transaction +
  `SET LOCAL app.user_id`). No driver call outside the DAL; no raw rows outside
  it. Route changes require `pnpm openapi:emit` (the committed
  `apps/server/openapi.json` is regen-diffed by the `contracts` gate).
- **Version-skew contract.** The desktop sends `x-client-version` (from
  tauri.conf.json); server middleware compares MAJOR versions and answers
  `409 { "error": "version_skew" }` on mismatch. It applies to every `/api/*`
  route (a unit test walks the route table to prove coverage); `/healthz` is
  exempt so the connection probe still works. Fleet installs lag releases —
  design API changes to tolerate an N-1 client (see
  `docs/runbooks/expand-contract.md`).
