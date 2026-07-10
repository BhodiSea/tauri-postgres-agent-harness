# Gates catalog

Companion to [the harness doctrine](./README.md). One section per default-on gate (the
16-step `VALIDATE_STEPS` chain in `tools/harness.config.mjs`), the Stop-hook runtime
suites, every opt-in module, and the gates we considered and rejected.

Every section carries an **anti-vacuity proof**: how to inject a violation and watch the
gate fail. A gate whose failure you have never seen is a gate you should not trust —
each of these was exercised once during template authoring, and you can re-run any of
them in a scratch branch. (Remember the write guard blocks some injections in-session;
inject via a plain editor or `HARNESS_ALLOW_SELF_EDIT=1` when noted.)

Shared behavior: gates self-skip LOUDLY when their prerequisite (cargo, an install, a
database, the surface itself) is absent locally, and fail closed in CI
(`CI=true` / `HARNESS_REQUIRE_TOOLCHAINS=1`). See the doctrine's
"skip-local / fail-closed-CI asymmetry".

## Default-on gates (`pnpm validate`, in order, cheap → expensive)

### 1. format — `pnpm exec biome ci .`

Formatting, import organization, and Biome's fast correctness basics, read-only
(CI-grade `ci`, not `check --write`). Fix with `pnpm format`.
**Anti-vacuity:** mis-indent any `.ts` file → FAIL naming the file.

### 2. rust-fmt — `node tools/run-rust-gates.mjs fmt`

`cargo fmt --check` over `apps/desktop/src-tauri`. Runs whenever cargo exists; skips
loudly without it. Fix with `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml`.
**Anti-vacuity:** collapse two Rust statements onto one line in `src/lib.rs` → FAIL with
the rustfmt diff. Also verify the asymmetry: unset cargo from PATH → `SKIPPED` locally,
and the same tree with `HARNESS_REQUIRE_TOOLCHAINS=1` → FAIL.

### 3. types — `pnpm exec tsc -b`

Solution-mode strict TypeScript across all five projects (composite project
references). Catches cross-package breakage the per-package editors miss.
**Anti-vacuity:** change a DTO field name in `@app/schema` without updating the server →
FAIL in the dependent project.

### 4. lint — `pnpm exec eslint . --max-warnings 0`

Type-aware rules (strictTypeChecked), jsx-a11y strict on the desktop, react-hooks +
React Compiler rules, sonarjs cognitive-complexity ≤ 15, plus the restricted-import
walls: chart libs banned in `features/{matrix,graph}` (hand-rolled SVG there),
`@tauri-apps/*` banned outside `src/ipc/**` + `src/keyboard/**`.
**Anti-vacuity:** `import { invoke } from '@tauri-apps/api/core'` in a random component
→ FAIL no-restricted-imports (the write guard blocks this in-session too — that is the
defense-in-depth working).

### 5. provenance — `node tools/check-sources.mjs`

Tree-wide scan for decision-site keywords (RLS SQL, `set_config`/`SET LOCAL`,
`jwtVerify`/JWKS/`clockTolerance`, hnsw/ivfflat/opclass, sampling/retry/timeout
constants) lacking `// SOURCE:` (`-- SOURCE:` in SQL) within a 3-line window. Identical
heuristic to the PostToolUse hook, so in-session and CI can never disagree. Pass by
citing an authority (add `[corpus: <id>]` when pinned in `tools/mcp/corpus/index.json`).
**Anti-vacuity:** add `const timeoutMs = 5000` with no citation → FAIL with file:line.

### 6. tauri-policy — `node tools/check-tauri-policy.mjs`

Pure-JSON asserts over the committed Tauri security surface: isolation pattern on; CSP
non-null / `default-src 'self'` / has `connect-src` / no `unsafe-eval`; no `dangerous*`
keys anywhere; identifier matches `tools/identity.lock.json`; WebView2
`offlineInstaller`; capabilities free of remote IPC, shell/process permissions, and `**`
fs scopes. <100ms, no cargo. Cannot be vacuous: the scaffold ships all inspected files,
so absence = FAIL in CI.
**Anti-vacuity:** set `"csp": null` in tauri.conf.json (editor, not agent — the write
guard denies it in-session) → FAIL.

### 7. version-sync — `node tools/check-version-sync.mjs`

One version everywhere (root/tauri.conf/server/desktop — the skew middleware compares
majors, so a drifted manifest makes the desktop lie about itself); Node majors agree
across `.nvmrc`/`.node-version`/`engines`; rc-churn tools EXACT-pinned in the catalog;
exactly one zod instance resolves workspace-wide. Pass by bumping versions together.
**Anti-vacuity:** bump only `apps/server/package.json` → FAIL listing all four versions.

### 8. prompts — `node tools/check-prompts-lock.mjs`

Every prompt file under `packages/*/prompts/` / `apps/*/prompts/` is sha256-locked in
`tools/prompts.lock.json` and versioned in its filename (`extract.v1.md`). Pass by
creating a NEW `.vN` file, re-running the eval, then deliberately updating the lock
(write-guard-protected — a human act).
**Anti-vacuity:** edit one word in `packages/eval/prompts/extract.v1.md` → FAIL hash
mismatch.

### 9. licenses — `node tools/check-licenses.mjs`

`pnpm licenses list --prod` against a permissive allowlist (MIT/ISC/Apache-2.0/BSD/
MPL-2.0 etc.); exceptions are reviewable data in `tools/license-exceptions.json`. Rust
crates: cargo-deny in the CI rust lane. Pass by replacing the dependency or (human
decision) recording an exception with a reason.
**Anti-vacuity:** `pnpm add` any GPL-3.0-only package as a prod dep → FAIL naming it.

### 10. schema-rls — `node tools/check-rls-manifest.mjs`

Every Drizzle `pgTable` in `packages/schema/src` has ENABLE + FORCE ROW LEVEL SECURITY
and per-operation policies (or `FOR ALL`) in the cumulative migration SQL, or an entry
in `tools/rls-exempt.json` (write-guard-protected, human-reviewed, reasons required).
Static existence proof; the runtime suite proves isolation.
**Anti-vacuity:** declare `pgTable('widgets', …)` with no migration → FAIL four times
(no ENABLE, no FORCE, missing policies).

### 11. migrations — `node tools/check-migrations.mjs`

Append-only (no committed migration modified/deleted vs HEAD, or vs the PR base in CI);
no DML without `-- harness-allow-dml: <reason>`; destructive DDL requires
`-- adr: docs/adr/<file>` pointing at an existing ADR. Pass by always generating a NEW
migration and following `docs/runbooks/expand-contract.md` for destructive phases.
**Anti-vacuity:** append a comment to an existing migration file (editor) → FAIL
append-only; add `DROP TABLE notes;` in a new migration without an ADR line → FAIL.

### 12. contracts — `node tools/check-contract-drift.mjs`

(1) OpenAPI regen-diff: `apps/server/scripts/emit-openapi.ts` (stable-stringified) must
equal the committed `apps/server/openapi.json` — pass with `pnpm openapi:emit` and
review the diff. (2) tsconfig project references mirror the workspace dependency graph.
**Anti-vacuity:** add a route without re-emitting → FAIL stale; delete a `references`
entry from a package tsconfig → FAIL naming the missing ref.

### 13. dead-code — `pnpm exec knip --strict`

Unused files, exports, and dependencies. Wire everything you add or delete it. NEVER
`knip --fix` (blocked): it auto-deletes with false positives.
**Anti-vacuity:** add an exported-but-unimported function → FAIL.

### 14. architecture — `pnpm exec depcruise apps packages --config .dependency-cruiser.cjs`

The dependency law: no cycles; desktop resolves no `postgres|drizzle-orm|pino|@hono/*`
nor anything in `apps/server`; drizzle confined to schema+server (drizzle-zod
schema-only); LLM SDK modules importable only from `packages/eval/src/adapters`.
**Anti-vacuity:** import a server module from a desktop file (editor — the write guard
also denies it in-session) → FAIL with the violation path.

### 15. build — `node tools/build-check.mjs`

`vite build` the desktop SPA, then grep the emitted `dist/` for forbidden markers
(ORM names, `MIGRATOR_DATABASE_URL`, connection-string prefixes, signing-material
references). The runtime backstop for gates 4/14: a transitive leak past static
analysis still shows up in the emitted JS.
**Anti-vacuity:** embed the literal string `MIGRATOR_DATABASE_URL` in a desktop
constant → build succeeds, gate FAILs on bundle purity.

### 16. rust-check — `node tools/run-rust-gates.mjs check`

`cargo check --locked` plus tauri-specta bindings drift (the export test regenerates
`apps/desktop/src/ipc/bindings.ts`; any git diff = stale committed bindings). Stamped:
`.harness/rust-check.ok` (sha256 over src-tauri + Cargo.lock) makes unchanged-Rust runs
instant locally; CI ignores the stamp. Clippy `-D warnings` runs in the CI rust lane.
**Anti-vacuity:** change a `#[tauri::command]` signature without committing regenerated
bindings → FAIL drift; introduce a type error in `lib.rs` → FAIL cargo check.

## Stop-hook runtime suites (`STOP_HOOK_STEPS`)

### rls-isolation — `node tests/rls/run-rls.mjs`

Live cross-user isolation against local Postgres (fresh-applies all migrations first).
Seeded positive control (a deny-all database must NOT pass), zero-row cross-user
SELECT/UPDATE/DELETE, SQLSTATE 42501 on INSERT smuggling, pooled-connection GUC-leak
detector (pool max=1), and the pg_catalog gate (FORCE RLS flags, per-op policies,
patched pgvector, non-BYPASSRLS role). Full doctrine: README "RLS testing doctrine".
**Anti-vacuity:** three distinct injections — (a) drop one policy in a new migration →
catalog gate + isolation matrix FAIL; (b) break `withUser` to skip `set_config` → the
positive control fails (nothing visible), proving the suite cannot green vacuously;
(c) change `set_config(..., true)` to `false` in a scratch copy → the GUC-leak test
fails.

### unit — `pnpm exec vitest run --silent`

The behavioral net: both projects (`unit-node`, `unit-dom`), including the
keyboard-registry WCAG 2.1.4 test, auth clock-skew (±4 pass / ±6 fail) and
production+stub boot-fatal tests, skew-middleware route-coverage walk, SSE abort
propagation, EMBEDDING_DIM assert, importer property tests, and the eval fixture scorer.
**Anti-vacuity:** register a bare single-character global shortcut in
`src/keyboard/registry.ts` → the WCAG test fails.

## Opt-in modules

`npx tauri-postgres-agent-harness enable <module>` copies the module's files and records
it in `.harness/manifest.json`. Most modules are pure file-drops (a workflow that is
live the moment it lands). The two validate-chain gate modules need one more step:
uncomment their entry in `tools/harness.config.mjs` — write-guard-protected, so a human
sets `HARNESS_ALLOW_SELF_EDIT=1` or edits outside an agent session (the installer prints
this hint on enable).

Tiers: `core` = none, `standard` = ci-provenance + ci-windows-release, `strict` = all.

| Module | What it adds | Why not default-on |
|---|---|---|
| `ci-windows-release` | the signed-release DAG: sign (Azure Trusted Signing) → `signtool verify /pa /all` → NSIS `/S` silent install/uninstall smoke → Defender scan with `-DisableRemediation` → determinism spot-check → checksums + `latest.json` → release automation; installer size budget | needs signing credentials, a Windows runner budget, and a release cadence |
| `ci-windows-e2e` | WebDriver E2E on Windows incl. enterprise-net simulation: TLS-intercepting-proxy smoke (private CA in the machine store), redirected-APPDATA, >280-char paths, WebView2 ProcessFailed kill/recover | slow Windows runners; needs the built binary, not the dev server |
| `ci-macos` | macOS build lane (development smoke; Windows stays the release target) | pays only if contributors develop on macOS |
| `ci-provenance` | SBOM for both ecosystems (npm + crates) + build attestation + verification step + NOTICES drift check | meaningful once artifacts ship to a consumer who verifies them |
| `mutation` | StrykerJS incremental per-PR on critical TS modules + `cargo-mutants --in-diff` for the Rust host | minutes-to-hours; pays off once there is authz/money logic worth mutating |
| `gate-perf-budget` | `tools/check-perf-budget.mjs` (uncomment in harness.config.mjs): pinned-runner, median-of-N interaction budgets | budgets are project-specific; a default budget is vacuous or wrong |
| `gate-a11y-deep` | route-manifest axe (WCAG 2.2 AA) + keyboard traversal + screen-reader checklist | needs real routes and a browser lane; the default keyboard-registry test already holds 2.1.4 |
| `gate-styleguide` | `tools/check-styleguide-manifest.mjs` (uncomment in harness.config.mjs): UI primitives and a manifest must never drift, keeping a styleguide screen a living source of truth | requires a styleguide surface + primitives manifest your project builds first |
| `crash-reporting` | self-hosted crash/error ingestion, PDB/symbol upload gates, a user-triggered diagnostics bundle, and a redaction unit test | needs an ingestion endpoint; redaction policy is project-specific |
| `ops-backup` | pgBackRest configuration + restore-drill runner + data-backfill runner with human-in-the-loop state-machine tests | operational infrastructure, not repo code; needs a real backup target |
| `eval-live` | GPU-runner live-model eval lane: GBNF/schema pre-validation, exemplar/holdout disjointness check, confidence calibration report | needs GPU hardware and a served model; the default eval is fixture-scored by design |
| `observability` | OpenTelemetry wiring for the server + a span-per-route unit test | adds a runtime dependency and an OTLP target decision better made deliberately |

## Considered and rejected

Recorded so the next maintainer doesn't re-litigate:

- **pgTAP** — the plain-SQL catalog assertions inside the vitest RLS suite check the
  same pg_catalog facts without a second test toolchain in the container.
- **specta drift inside the `contracts` gate** — bindings drift needs cargo, so it rides
  `rust-check` (and the CI rust lane); `contracts` stays install-only.
- **DAST/ZAP baseline** — the server has no public routes in this deployment shape
  (on-prem, CSP-pinned desktop client); SAST (CodeQL) + the policy gates cover the
  reachable surface.
- **ts-prune** — superseded by `knip --strict`.
- **lockfile-lint** — low signal over pnpm strict lockfiles + frozen-lockfile CI installs.
- **type-coverage** — a percentage on top of `strict` invites gaming; the type-aware
  ESLint rules ban the specific escapes directly.
- **markdownlint** — prose churn without real defects; Biome formats what matters.
- **byte-reproducible builds** — signed NSIS artifacts embed timestamps/signatures and
  cannot be honestly byte-identical; the achievable claims are determinism-by-pinning
  (rust-toolchain.toml, Cargo.lock `--locked`, exact catalog pins, frozen lockfiles) plus
  attestation (`ci-provenance`).
- **deterministic same-turn test-edit bans** — a hook cannot distinguish reward-hacking
  from legitimate code+tests feature work; kept as a review-time rule plus the
  `mutation` module, which catches the damage rather than the act.
- **max-lines file/function caps** — proxy metrics that punish cohesive modules;
  sonarjs cognitive-complexity ≤ 15 targets the actual failure mode.
