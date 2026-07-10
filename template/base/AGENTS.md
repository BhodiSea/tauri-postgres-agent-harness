# AGENTS.md — {{PROJECT_NAME}} desktop platform

Canonical project memory (CLAUDE.md points here). Advisory context — the Stop
hook + CI are the real enforcement. Keep under ~200 lines.
SOURCE: docs/harness/README.md.

## Stack (pnpm monorepo, versions live ONLY in the pnpm-workspace.yaml catalog)

- **apps/desktop** — Tauri 2 + React 19 + Vite SPA (WebView2 on Windows, NSIS
  installer). Tauri APIs enter ONLY through `src/ipc/**` (tauri-specta bindings)
  and `src/keyboard/**`. CSP is committed in `tauri.conf.json`; isolation
  pattern is on.
- **apps/server** — Hono + Node 22 API on `PORT` (default 8787). Auth =
  `AUTH_MODE=stub|entra`, one jose `jwtVerify` path (pinned iss/aud/alg,
  `clockTolerance: 300`). Boot-time fatal: `NODE_ENV=production` + stub.
- **packages/schema** — `@app/schema`: Zod contracts + Drizzle schema +
  append-only migrations in `packages/schema/drizzle/`. `EMBEDDING_DIM = 1024`.
- **packages/importer** — deterministic parsers + fast-check property tests.
- **packages/eval** — Inference/Embedding ports, fixture-scored eval, versioned
  hash-locked prompts. NO live model calls anywhere in the repo.
- **Postgres 16 + pgvector** via `docker-compose.yml` (`pnpm db:up`). Roles from
  `db/init/01-roles.sql`: `app_migrator` (owns schema, migrations only) and
  `app_api` (the server's login role — NOSUPERUSER, NOBYPASSRLS, FORCE RLS).

## Package manager: pnpm 11 (pinned via `packageManager`), Node >= 22

ALWAYS `pnpm`, never `npm`/`yarn`. Workspace deps = `workspace:*`; external
versions = `catalog:` (the catalog is the only place version numbers appear).

## Commands

- `pnpm validate` — **THE GATE**: `node tools/validate.mjs`, the 16-step chain
  from `tools/harness.config.mjs` (see below). Must be green before a turn ends.
- `pnpm typecheck` (`tsc -b`) · `pnpm lint` / `pnpm lint:fix` · `pnpm format`
  (`biome check --write .`) · `pnpm knip` · `pnpm arch` (depcruise).
- `pnpm test` (`vitest run`) · `pnpm test:rls` (`node tests/rls/run-rls.mjs` —
  live cross-user isolation against local Postgres).
- `pnpm db:up` · `pnpm db:migrate` (drizzle-kit migrate as `app_migrator`).
- `pnpm dev:server` · `pnpm dev:desktop` · `pnpm openapi:emit`.

## The validate contract (YOU MUST)

- A turn is NOT done until `pnpm validate` is green. The Stop hook re-runs
  validate + `node tests/rls/run-rls.mjs` + `pnpm exec vitest run --silent` and
  exits 2 until everything passes. Fix root causes; do not stop.
- **Prove, don't claim.** Show passing gate output; never assert "it works".
- Do NOT edit a test in the same turn as the fix it covers (reward-hacking).
- The 16 gates, in order: `format`, `rust-fmt`, `types`, `lint`, `provenance`,
  `tauri-policy`, `version-sync`, `prompts`, `licenses`, `schema-rls`,
  `migrations`, `contracts`, `dead-code`, `architecture`, `build`, `rust-check`
  (docs/harness/gates-catalog.md documents each).
- **Toolchain asymmetry:** gates needing cargo or a live database SKIP LOUDLY
  locally when the prerequisite is absent and FAIL CLOSED in CI
  (`CI=true` / `HARNESS_REQUIRE_TOOLCHAINS=1`). A skip is never a pass — do not
  treat a SKIPPED line as done if you can install the prerequisite.

## Security invariants (NON-NEGOTIABLE — hook- and lint-enforced)

- **`withUserContext(userId, fn)` IS the authorization boundary.** Every
  `apps/server/src/dal/*` module acquires the database through it (opens a tx,
  `SET LOCAL app.user_id`), returns Zod-parsed DTOs, never raw rows. Routes
  never touch the db driver. **Tauri IPC, capabilities, and the CSP are NOT
  authorization** — they are containment; authorize in the DAL, on FORCE RLS.
- **GUC discipline:** RLS identity is `set_config('app.user_id', $uuid, true)`
  inside a transaction. NEVER `set_config(..., false)`, `SET SESSION app.*`, or
  bare `SET app.*` — session GUCs leak identity across pooled connections.
- **Migrations are append-only.** Never edit or delete a committed migration —
  add a new one (`drizzle-kit generate`). `drizzle-kit push`/`drop` are blocked.
  Destructive DDL (DROP TABLE/COLUMN, TRUNCATE) needs `-- adr: docs/adr/<file>`;
  DML in a migration needs `-- harness-allow-dml: <reason>`.
- **`MIGRATOR_DATABASE_URL` bypasses RLS** (schema owner). Sanctioned uses only:
  drizzle-kit migrate/generate/check and `tests/migrations/`. Never in app code.
- **Every new table ships FORCE RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY` +
  four per-operation policies reading
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern), in
  the same migration. Exemptions = human-reviewed `tools/rls-exempt.json`.
- **Desktop-bundle purity:** `apps/desktop` never imports `postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, or anything in `apps/server`. It talks
  to the API via typed contracts from `@app/schema`.
- **No VITE_-prefixed secret-shaped names** (`VITE_*KEY|SECRET|TOKEN|PASSWORD|
  PRIVATE`) — VITE_ vars compile into the shipped client bundle.
- **No `dangerouslySetInnerHTML`.** Sanitize and render text.
- **Tauri surface:** CSP never null; `pattern.use` stays `"isolation"`; no
  `dangerous*` options; `webviewInstallMode` stays `offlineInstaller`;
  capabilities grant no remote-URL IPC, no shell/process permissions, no `**`
  fs scopes (add a typed `#[tauri::command]` instead); `src-tauri/Cargo.toml`
  keeps `unsafe_code = "forbid"`. Bundle identifier is locked in
  `tools/identity.lock.json` — it is upgrade identity and never changes.
- **`WITH RECURSIVE` requires a `CYCLE` clause or visited guard** — graph data
  loops forever otherwise.
- **Keyboard shortcuts** live in `apps/desktop/src/keyboard/registry.ts`
  (`SHORTCUTS`); no unmodified single-printable-character global shortcut
  (WCAG 2.1.4 — a registry-iterating unit test enforces it).
- **Prompt lock discipline:** every LLM prompt file is versioned in its name
  (`extract.v1.md`) and hash-locked in `tools/prompts.lock.json`. Changing a
  prompt = new `.vN` file + re-run the eval + deliberate lock update (the lock
  is write-guard-protected).
- **Shell hygiene** (bash-guard enforced): no `rm -rf`, no force-push, no
  `git reset --hard`, no `git commit --no-verify`, no reading `.env*` /
  `.dev-auth/`, no `pnpm|cargo update` (Renovate owns bumps), no `knip --fix`,
  no destructive raw SQL outside migrations, and updater signing material
  (`TAURI_SIGNING_PRIVATE_KEY`, minisign secret keys) never touches shell or repo.

## Quality bar

- Data structures first: design schema/DTO/contract before code.
- Eliminate special-casing; delete code; justify every abstraction. `knip
  --strict` stays green. Cognitive complexity <= 15 (ESLint error).
- Adversarial self-review before declaring done: try to break your own code.
- Charts in `features/{matrix,graph}` are hand-rolled SVG (chart libs banned
  there by lint); a11y is jsx-a11y strict, WCAG 2.2 AA.

## Provenance

- Non-trivial decision sites (RLS SQL, jwtVerify/JWKS options, vector index
  choices, retry/timeout/sampling constants, CSP) carry
  `// SOURCE: <authority> [corpus: <id>]` (`-- SOURCE:` in SQL) on/above the
  line. Corpus ids resolve against `tools/mcp/corpus/index.json` (use the
  `corpus_search` MCP tool mid-turn; extend the corpus in the PR that cites it).
- Emit one ADR per slice via `/adr <slice>` (records in `docs/adr/`); then run
  `/verify-citations` until it returns `CITATIONS: CLEAN`.

## Spec-first & governance

- **Spec-first** for anything touching auth, RLS, migrations, the Tauri
  security surface (capabilities/CSP), or the API contract: write
  `specs/<feature>.md` (template: `specs/_template.md`), get sign-off, then
  implement. `/new-feature <name>` drives the
  migration → RLS → DAL → route → IPC/UI → test → provenance → gate recipe.
- Schema changes follow the expand→contract runbook
  (`docs/runbooks/expand-contract.md`) — desktop clients skew by a version.
- Reviewers are read-only subagents: `security-reviewer` (MUST run on RLS/DAL/
  auth/capabilities/CSP changes), `torvalds-reviewer` before finishing,
  `citation-verifier` via `/verify-citations`.
- PRs paste real `pnpm validate` + `pnpm test:rls` output; CODEOWNERS
  ({{SECURITY_OWNERS}}) sign off on auth/data/harness surfaces. New MCP servers
  or Skills must be registered in `docs/security/approved-tools.md` first. Keep
  private data out of the lethal trifecta
  (`docs/security/sandbox-and-supply-chain.md`).
