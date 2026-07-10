# Security invariants (always loaded; also hook- and lint-enforced)

These are non-negotiable. They are enforced deterministically by the
PreToolUse/Stop hooks, ESLint/depcruise, and the gate scripts; write code that
already satisfies them so the gates never fire.
SOURCE: docs/harness/README.md (security-invariants rule)

- **`withUserContext(userId, fn)` is THE authorization boundary.** Every
  `apps/server/src/dal/*` module acquires the database through it (transaction +
  `SET LOCAL app.user_id`, over FORCE RLS) and returns Zod-parsed DTOs, never raw
  driver rows. Routes never import the db driver. **Tauri IPC, capabilities, and
  the CSP are NOT authorization** — the webview is an untrusted client.
- **GUC discipline.** RLS identity is `set_config('app.user_id', $uuid, true)` /
  `SET LOCAL` inside a transaction. Never `set_config(..., false)`, `SET SESSION
  app.*`, or bare `SET app.*` — a session GUC leaks the previous user's identity
  across pooled connections.
- **Migrations are append-only.** Never edit or delete a committed file under
  `packages/schema/drizzle/` — add a new migration (`drizzle-kit generate`).
  `drizzle-kit push` and `drizzle-kit drop` are blocked. Destructive DDL requires
  `-- adr: docs/adr/<file>`; DML requires `-- harness-allow-dml: <reason>`.
- **`MIGRATOR_DATABASE_URL` is the RLS-bypassing role** (schema owner). Only
  drizzle-kit migrate/generate/check and `tests/migrations/` may use it — never
  app, test-assertion, or script code.
- **Every table ships `ENABLE` + `FORCE ROW LEVEL SECURITY`** and four
  per-operation policies scoped to
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern), in
  the same migration that creates it. Exemptions live only in the human-reviewed
  `tools/rls-exempt.json`.
- **Desktop-bundle purity.** `apps/desktop` never imports `postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, or anything in `apps/server`; Tauri
  APIs (`@tauri-apps/*`) are imported only inside `src/ipc/**` and
  `src/keyboard/**`.
- **Tauri surface.** `tauri.conf.json`: CSP never null, `pattern.use` stays
  `"isolation"`, no `dangerous*` options, `webviewInstallMode` stays
  `offlineInstaller`. Capabilities: no remote-URL IPC, no `shell:allow-*` /
  `process:allow-*`, no `**` filesystem scopes — add a typed `#[tauri::command]`
  instead. `src-tauri/Cargo.toml` keeps `unsafe_code = "forbid"`.
- **Never put a secret behind a `VITE_` name** (`VITE_*KEY|SECRET|TOKEN|
  PASSWORD|PRIVATE`) — VITE_ vars are compiled into the shipped client bundle.
- **Never use `dangerouslySetInnerHTML`** — sanitize and render text, or request
  security review.
- **`WITH RECURSIVE` requires a `CYCLE` clause or visited guard** — recursive
  queries over graph data loop forever otherwise.
- **Signing material never touches the repo or shell.** `TAURI_SIGNING_PRIVATE_KEY`
  is CI-secret-injected only; minisign secret keys are never read, generated, or
  echoed.
- **No `rm -rf`, no force-push, no `git reset --hard`, no `git commit
  --no-verify`, no reading `.env*` / `.dev-auth/`**, no `pnpm|cargo update`
  (Renovate owns dependency bumps), no `knip --fix`, no destructive raw SQL
  outside a reviewed migration.
