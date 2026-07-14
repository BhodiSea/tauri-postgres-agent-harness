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

- `pnpm validate` — **THE GATE**: `node tools/validate.mjs`, the 22-step chain
  from `tools/harness.config.mjs` (see below). Must be green before a turn ends.
- `pnpm typecheck` (`tsc -b`) · `pnpm lint` / `pnpm lint:fix` · `pnpm format`
  (`biome check --write .`) · `pnpm knip` · `pnpm arch` (depcruise).
- `pnpm test` (`vitest run`) · `pnpm test:rls` (`node tests/rls/run-rls.mjs` —
  live cross-user isolation against local Postgres).
- `pnpm db:up` · `pnpm db:migrate` (drizzle-kit migrate as `app_migrator`).
- `pnpm dev:server` · `pnpm dev:desktop` · `pnpm openapi:emit`.

## The validate contract (YOU MUST)

- A turn is NOT done until `pnpm validate` is green. The Stop hook re-runs
  validate + `node tests/rls/run-rls.mjs` + `pnpm exec vitest run --silent` +
  `node tools/check-diff-coverage.mjs` + `node tools/check-duplication.mjs`
  (token clones across `apps/*/src` + `packages/*/src`) + `node tools/check-i18n.mjs`
  (no hardcoded user-facing string; locale-sensitive formatting only in `src/i18n/`)
  + `node tools/check-test-quality.mjs` (every test asserts something; nothing
  focused or disabled) + `node tools/check-native-perf.mjs --closure` (every
  `#[tauri::command]` has a criterion bench and a budget) and exits 2 until
  everything passes. Fix root causes; do not stop.
- **Prove, don't claim.** Show passing gate output; never assert "it works".
- Do NOT edit a test in the same turn as the fix it covers (reward-hacking).
- The 22 gates, in order: `format`, `gate-integrity`, `rust-fmt`, `types`,
  `lint`, `provenance`, `tauri-policy`, `version-sync`, `prompts`, `licenses`,
  `schema-rls`, `migrations`, `contracts`, `dead-code`, `architecture`, `build`,
  `rust-check`, `styleguide`, `perf-budget`, `route-manifest`, `e2e`,
  `docs-sync` (docs/harness/gates-catalog.md documents each).
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
- **The desktop talks to the API ONLY through `src/lib/api-client.ts`** —
  `apiFetch`/`apiPost` attach the bearer token and decode the error envelope. Never
  call `fetch()` directly from a feature: an unauthenticated request 401s against the
  real server, and every unit test + e2e spec mocks the network, so nothing local
  would tell you. The token is held by the Tauri HOST (`access_token` over typed IPC,
  wired in `main.tsx`) — never a `VITE_` var (compiled into the bundle) and never
  webview storage. The desktop is CROSS-ORIGIN to the API (`tauri://localhost`), so
  the server's CORS allowlist runs ahead of the auth guard; a preflight carries no
  token by definition. `e2e/integration.spec.ts` (CI-only `integration` lane) is the
  one place both halves run for real.
- **GUC discipline:** RLS identity is `set_config('app.user_id', $uuid, true)`
  inside a transaction. NEVER `set_config(..., false)`, `SET SESSION app.*`, or
  bare `SET app.*` — session GUCs leak identity across pooled connections.
- **Migrations are append-only.** Never edit or delete a committed migration —
  add a new one (`drizzle-kit generate`). `drizzle-kit push`/`drop` are blocked.
  Destructive DDL (DROP TABLE/COLUMN, TRUNCATE) needs `-- adr: docs/adr/<file>`;
  DML in a migration needs `-- harness-allow-dml: <reason>`.
- **`MIGRATOR_DATABASE_URL` bypasses RLS** (schema owner). Sanctioned uses only:
  drizzle-kit migrate/generate/check and the harness RLS runners
  (`tests/migrations/`, `tests/rls/` — plan-probe seeding + ANALYZE). Never in
  app or assertion code: isolation asserts always run as `app_api`.
- **Every new table ships FORCE RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY` +
  four per-operation policies reading
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern) +
  a leading-column index on the owner column (the policies filter by it on
  every statement — `schema-rls` and the runtime plan probe both enforce it),
  in the same migration. Exemptions = human-reviewed `tools/rls-exempt.json`.
- **Every DAL method is registered in `tests/rls/dal-shapes.ts`** — and so is every
  interesting ARGUMENT shape (a first page and a cursor page plan differently). The plan
  probe drives the REAL DAL through a capturing pg-proxy and `EXPLAIN`s the SQL it emits at
  scale, redding on any `Seq Scan`, `Sort` or per-row `SubPlan`; an unregistered method is
  a query nothing measures, and the registry closure reds the turn. **The index must carry
  the ORDERING, not just the filter**: an index on `(owner_id)` alone leaves a keyset list
  sorting the owner's entire partition on every page — index `(owner_id, <the ORDER BY
  columns, in their declared direction>)` so one index serves the policy, the sort and the
  cursor range (`0002_notes_keyset_idx.sql` is the worked pattern).
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
- **Server surface:** errors through the ONE envelope
  (`src/errors.ts` — `{ error: { code, message, requestId } }`, declared 4xx/5xx
  per route); every wire string bounded (`.max()`); every list keyset-paginated
  with an unconditional LIMIT and a statement-count invariance test
  (`dal/notes.ts` + `dal/cursor.ts` are the worked pattern).
- **Coverage floors are enforced**: the Stop hook runs
  `vitest run --coverage` against the thresholds in `vitest.config.ts`, then
  `tools/check-diff-coverage.mjs` holds every CHANGED source file to the
  per-file floors there — a feature landing without tests reds the turn.
- **Coverage is not verification, and the harness measures BOTH.** Coverage
  proves a test EXECUTED your line. It cannot see that the test asserts nothing,
  and it cannot see that the assertion is wrong. Two controls close that:
  - `tools/check-test-quality.mjs` (Stop chain, ~50ms): every `it`/`test` body
    must contain an assertion call; a committed `.only` is fatal with NO escape
    (it silently disables every other test in the run while the suite reports
    green); a `.skip`/`.todo` MODIFIER is a declared test that never runs.
    Playwright's RUNTIME conditional skip — `test.skip(condition, reason)` — is
    a different construct and stays green. Reviewed escapes:
    `tools/test-quality-allow.json` (a reason is mandatory).
  - **The mutation lane** (CI, blocking): StrykerJS changes your code and asks
    whether a test goes red. It runs on the CRITICAL surface —
    `apps/server/src/**`, `apps/desktop/src/{auth,lib}/**`
    (`tools/lib/mutation-critical.mjs`) — scoped to the files a PR touched, plus
    a nightly full sweep. The gate is a SET-based ratchet against
    `tools/mutation-baseline.json`, never a score threshold: a NEW surviving
    mutant reds. **Accepting a survivor is a reviewed human act** — the file is
    write-guard-protected and the gate FAILS on an entry with an empty reason.
    Write the test that kills it; only record a survivor when no behaviour can
    distinguish it (a redundant guard TypeScript needs, a Node API that treats
    an empty string exactly like the value it replaced). Run it yourself with
    `pnpm mutation`.
  This is not theory. On the v0.1.5 exemplar every gate was green, coverage
  passed, and the JWT algorithm allowlist, the error-envelope truncation bound,
  and the whole `AUTH_MODE=entra` path could each be broken without a single
  test failing.
- **Every `#[tauri::command]` you add must be benched.** The perf lane runs
  `vite dev` against a MOCKED IPC bridge, so it sees nothing of the real host —
  through v0.1.5 command cost and the boot path were measured by nothing at all.
  `tools/check-native-perf.mjs --closure` (Stop chain) therefore requires every
  command in `src-tauri/src/lib.rs` to have a criterion bench in
  `benches/host.rs` AND a `subjects[]` entry in `tools/native-perf-budget.json`;
  the CI rust lane runs the bench and enforces the budget. Add the command, add
  it to `COMMANDS`, run `cargo bench --bench host`, write the measured ratio in
  with headroom. **Budgets are RATIOS to the cheapest command, never
  nanoseconds** — a shared runner's raw timings vary 27–40% run-to-run, which is
  enough to make an absolute budget either flaky or meaningless. Do not raise a
  cap to get to green: the file is write-guard-protected because raising it
  re-baselines the regression the bench just caught. Keep expensive work
  (keychain reads, token refresh, network, sync file IO) OFF the synchronous
  invoke path and out of `.setup()` — that is what this gate exists to catch.
- **Styling is tokens-only, in BOTH themes.** The `@theme` in
  `apps/desktop/src/styles.css` (dark = base) + `:root[data-theme='light']` +
  `tools/styleguide.manifest.json` are the ENTIRE design vocabulary: default
  Tailwind palette/scales are erased; raw hex/px, inline `style={}`, and
  arbitrary-value escapes (`w-[13px]`) are gate-red. The gate COMPUTES WCAG
  contrast from the OKLCH tokens for every pair in both themes (extend tokens
  + manifest in one reviewed diff); body text (ink on canvas/surface) holds
  AAA 7:1, secondary ink stays AA 4.5. Light/dark parity is axe-swept per
  route; `@media (forced-colors: active)` keeps boundaries/focus/pending-dashed
  visible under Windows High Contrast (e2e-locked, no-preference control).
- **Interactive controls render through `src/components` primitives**
  (Button/Input/Field/Skeleton/Toast/EmptyState) — a raw button/input/select/
  textarea tag with a literal `className` outside `src/components` is gate-red
  (the styleguide gate's primitive-boundary scan; reviewed `controlAllow`
  entries in `tools/styleguide.manifest.json` are the only escape); new control
  styling goes into the primitive.
- **Write UX follows `features/notes`**: optimistic insert with a temp id,
  reconcile-or-rollback in ONE plain reducer (`useCreateNote.ts`), the form
  through Field/Input/Button with inline zod errors at the fetch boundary,
  failures surfaced as envelope-message toasts — never a phantom row after a
  failed write (`NoteComposer.tsx` is the worked pattern; `e2e/mutation.spec.ts`
  locks both paths with held/fulfilled routes, zero sleeps).
- **The command palette follows `features/palette`**: every command is typed —
  `group` REQUIRED (the CommandGroup union), optional subtitle/keys, keys hints
  DERIVED from `keyboard/registry.ts`, never hand-typed. Ranking is the pure
  deterministic subsequence scorer (`fuzzyScore.ts`: word-boundary + run
  bonuses, score→title→id tie-break, property-tested); recents (`recents.ts`,
  capped + corrupt-safe localStorage) pin first ONLY on the empty query —
  typing swaps wholly to ranked results. Screens contribute contextual
  commands via the `RegisterCommands` prop (matrix is the worked pattern);
  `e2e/palette.spec.ts` locks ranking, recents, and the keyboard-only flow.
- **Every effect that registers something tears it down.** `addEventListener` →
  `removeEventListener`, `setInterval` → `clearInterval`, `requestAnimationFrame` →
  `cancelAnimationFrame`, an Observer → `.disconnect()`, `.subscribe(` → `.unsubscribe()`
  — in the cleanup the effect RETURNS (`return () => {}` does not count, and the
  perf-budget gate's leak scan blanks comments first, so a teardown named only in a
  comment does not either). A leaked listener costs nothing on first mount, which is why
  nothing else can see it: the render benchmark mounts once and the e2e suite never
  navigates back. The CI-only memory ceiling (`e2e/memory.spec.ts`) counts live
  window/document listeners across a mount/unmount loop and reds on growth.
- **Every user-facing string is a key in `apps/desktop/src/i18n/catalog.ts`.** No literal in
  JSX, in `aria-label`/`title`/`placeholder`/`label`/`alt`, or in the object literals that
  hold copy (route names, shortcut descriptions, palette titles, column headers). Render it
  with `t('key')` — `const { t } = useI18n()` in a component, the plain `t` export outside
  one (the store is module-level precisely so `matrixData.ts` and `perfSubject.ts` can use
  it). Plurals come from `Intl.PluralRules` via a `count` param, never an `if`. `Intl`,
  `toLocale*` and `.toFixed()` are BANNED outside `src/i18n/` — `.toFixed(2)` hardcodes the
  `.` decimal mark, so a German reader sees `0.75` where they write `0,75`. Numbers and dates
  reach the screen through message placeholders and the `format*` helpers. An error's
  user-facing copy comes from the envelope's stable `code` (`i18n/errors.ts`); the server's
  raw `message` is a support detail, never the sentence a user is asked to read. Turn-fatal
  (`i18n` Stop step); the e2e pseudo-locale + RTL sweep catches what the scan cannot.
- **Motion is opt-in**: animations only behind `motion-safe:`, with the global
  `prefers-reduced-motion` backstop in styles.css — e2e asserts the held
  loading skeleton runs ZERO animations under reduced motion.
- **Data-dense screens follow `features/matrix`**: virtualized window
  (`useVirtualWindow`), APG roving-tabindex grid (`useRovingGrid`,
  aria-rowcount over the windowed DOM), keyset pagination (`useKeysetQuery`).
  The perf-budget gate measures REAL subjects, not a synthetic fixture, and
  enforces closure: every `features/*` dir importing those hooks ships a
  `perfSubject.ts` declared in `tools/perf-budget.json` `subjects[]` (matrix is
  the worked pattern; `exempt: [{ dir, reason }]` is the reviewed escape).
  Absolute wall-clock UX budgets (TTI, arrow-key latency, long tasks) run in
  the CI-only perf lane (`HARNESS_PERF_LANE=1`, budgets in
  `tools/interaction-budget.json`) — deliberately NEVER in the validate chain.
- Charts in `features/{matrix,graph}` are hand-rolled SVG (chart libs banned
  there by lint); a11y is jsx-a11y strict, WCAG 2.2 AA.

## Provenance

- Non-trivial decision sites (RLS SQL, jwtVerify/JWKS options, vector index
  choices, retry/timeout/sampling constants, CSP) carry
  `// SOURCE: <authority> [corpus: <id>]` (`-- SOURCE:` in SQL) on/above the
  line. Corpus ids resolve against `tools/mcp/corpus/index.json` (use the
  `corpus_search` MCP tool mid-turn; extend the corpus in the PR that cites it).
  Cite an entry whose `groups` cover the decision's class (cross-group escapes =
  human-reviewed `tools/provenance-overrides.json`); a bare URL counts only on a
  `tools/lib/citation-domains.mjs` allowlisted host — otherwise pin it in the corpus.
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
- Reviewers are read-only subagents (the `docs-sync` gate asserts their
  frontmatter stays read-only): `security-reviewer` (MUST run on RLS/DAL/
  auth/capabilities/CSP changes), `torvalds-reviewer` before finishing,
  `citation-verifier` via `/verify-citations`.
- PRs paste real `pnpm validate` + `pnpm test:rls` output; CODEOWNERS
  ({{SECURITY_OWNERS}}) sign off on auth/data/harness surfaces. New MCP servers
  or Skills must be registered in `docs/security/approved-tools.md` first. Keep
  private data out of the lethal trifecta
  (`docs/security/sandbox-and-supply-chain.md`).
