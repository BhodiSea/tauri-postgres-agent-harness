# Gates catalog

Companion to [the harness doctrine](./README.md). One section per default-on gate (the
22-step `VALIDATE_STEPS` chain in `tools/harness.config.mjs`), the Stop-hook runtime
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

### 2. gate-integrity — `node tools/check-gate-integrity.mjs`

Recomputes sha256 over the RAW bytes of every harness-owned enforcement file recorded
in `.harness/manifest.json` (`tools/`, `.claude/hooks/`, `.claude/settings.json`, the
RLS and migration runners) and fails on any mismatch or missing file — a raw write that
slipped past the write-guard hook (shell redirection, `sed -i`, an external editor)
reds the very next validate run. `config` and `seeded` entries are human-tunable and
skipped (`update` re-records the config hash on sanctioned changes). Deliberately the
first gate after format: tampered gates must not get to run. Pass by restoring the
file from git, or — after a sanctioned harness upgrade — re-running
`npx tauri-postgres-agent-harness update` (it re-records the hashes).
**Anti-vacuity:** `echo '// x' >> tools/check-migrations.mjs` from a plain terminal →
FAIL naming the file.

### 3. rust-fmt — `node tools/run-rust-gates.mjs fmt`

`cargo fmt --check` over `apps/desktop/src-tauri`. Runs whenever cargo exists; skips
loudly without it. Fix with `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml`.
**Anti-vacuity:** collapse two Rust statements onto one line in `src/lib.rs` → FAIL with
the rustfmt diff. Also verify the asymmetry: unset cargo from PATH → `SKIPPED` locally,
and the same tree with `HARNESS_REQUIRE_TOOLCHAINS=1` → FAIL.

### 4. types — `pnpm exec tsc -b`

Solution-mode strict TypeScript across all five projects (composite project
references). Catches cross-package breakage the per-package editors miss.
**Anti-vacuity:** change a DTO field name in `@app/schema` without updating the server →
FAIL in the dependent project.

### 5. lint — `pnpm exec eslint . --max-warnings 0 --cache`

Type-aware rules (strictTypeChecked), jsx-a11y strict on the desktop, react-hooks +
React Compiler rules, sonarjs cognitive-complexity ≤ 15, plus the restricted-import
walls: chart libs banned in `features/{matrix,graph}` (hand-rolled SVG there),
`@tauri-apps/*` banned outside `src/ipc/**` + `src/keyboard/**`.
**Anti-vacuity:** `import { invoke } from '@tauri-apps/api/core'` in a random component
→ FAIL no-restricted-imports (the write guard blocks this in-session too — that is the
defense-in-depth working).

### 6. provenance — `node tools/check-sources.mjs`

Tree-wide scan for decision-site keywords (RLS SQL, `set_config`/`SET LOCAL`,
`jwtVerify`/JWKS/`clockTolerance`, hnsw/ivfflat/opclass, sampling/retry/timeout
constants) lacking `// SOURCE:` (`-- SOURCE:` in SQL) within a 3-line window. Identical
heuristic to the PostToolUse hook, so in-session and CI can never disagree. Pass by
citing an authority (add `[corpus: <id>]` when pinned in `tools/mcp/corpus/index.json`).
Two semantic checks ride on top (v0.1.5, rampNote-gated — NOTE-only on pre-0.1.5
baseVersions): a cited corpus entry that declares `groups` must cover the site's own
decision group (reviewed cross-group escapes live in `tools/provenance-overrides.json`;
groups-less entries stay presence-checked), and a bare-URL citation grounds only when
its host is on the `tools/lib/citation-domains.mjs` allowlist.
**Anti-vacuity:** add `const timeoutMs = 5000` with no citation → FAIL with file:line;
cite `[corpus: llamacpp/sampling]` on a `jwtVerify` line → FAIL naming the group
mismatch; cite a bare URL on a non-allowlisted host → FAIL naming the host.

### 7. tauri-policy — `node tools/check-tauri-policy.mjs`

Pure-JSON asserts over the committed Tauri security surface: isolation pattern on; CSP
non-null / `default-src 'self'` / has `connect-src` / no `unsafe-eval`; no `dangerous*`
keys anywhere; identifier matches `tools/identity.lock.json`; WebView2
`offlineInstaller`; capabilities free of remote IPC, shell/process permissions, and `**`
fs scopes. <100ms, no cargo. Cannot be vacuous: the scaffold ships all inspected files,
so absence = FAIL in CI.
**Anti-vacuity:** set `"csp": null` in tauri.conf.json (editor, not agent — the write
guard denies it in-session) → FAIL.

### 8. version-sync — `node tools/check-version-sync.mjs`

One version everywhere (root/tauri.conf/server/desktop — the skew middleware compares
majors, so a drifted manifest makes the desktop lie about itself); Node majors agree
across `.nvmrc`/`.node-version`/`engines`; rc-churn tools EXACT-pinned in the catalog;
exactly one zod instance resolves workspace-wide. Pass by bumping versions together.
Stamped: `.harness/version-sync.ok` (sha256 over the four version manifests,
`.nvmrc`/`.node-version`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`) short-circuits a
warm unchanged run in ms — the win is skipping the `pnpm list -r --json` subprocess
that dominates the gate's wall time. Staleness analysis: the verdict is a pure function
of those files, and the single-zod-instance graph is fully determined by the lockfile
(not the installed `node_modules` bytes), so an unchanged digest cannot hide a real
drift; CI always re-runs regardless.
**Anti-vacuity:** bump only `apps/server/package.json` → FAIL listing all four versions.

### 9. prompts — `node tools/check-prompts-lock.mjs`

Every prompt file under `packages/*/prompts/` / `apps/*/prompts/` is sha256-locked in
`tools/prompts.lock.json` and versioned in its filename (`extract.v1.md`). Pass by
creating a NEW `.vN` file, re-running the eval, then deliberately updating the lock
(write-guard-protected — a human act).
**Anti-vacuity:** edit one word in `packages/eval/prompts/extract.v1.md` → FAIL hash
mismatch.

### 10. licenses — `node tools/check-licenses.mjs`

`pnpm licenses list --prod` against a permissive allowlist (MIT/ISC/Apache-2.0/BSD/
MPL-2.0 etc.); exceptions are reviewable data in `tools/license-exceptions.json`. Rust
crates: cargo-deny in the CI rust lane. Pass by replacing the dependency or (human
decision) recording an exception with a reason.
**Anti-vacuity:** `pnpm add` any GPL-3.0-only package as a prod dep → FAIL naming it.

### 11. schema-rls — `node tools/check-rls-manifest.mjs`

Every Drizzle `pgTable` in `packages/schema/src` has ENABLE + FORCE ROW LEVEL SECURITY
and per-operation policies (or `FOR ALL`) in the cumulative migration SQL, or an entry
in `tools/rls-exempt.json` (write-guard-protected, human-reviewed, reasons required).
Policy predicates must be real (no `USING (true)`) and initPlan-shaped; every
migration-created table must be a declared `pgTable`; every non-exempt table must be
in `ISOLATION_TARGETS` (`tests/rls/db-context.ts`); and every target's owner column
must be the LEADING column of a migration-created index — the policies filter by it
on every statement (see `0001_notes_owner_idx.sql`).
Static existence proof; the runtime suite proves isolation and the access path.
**Anti-vacuity:** declare `pgTable('widgets', …)` with no migration → FAIL four times
(no ENABLE, no FORCE, missing policies); delete the owner-index migration → FAIL
naming the missing leading column.

### 12. migrations — `node tools/check-migrations.mjs`

Append-only (no committed migration modified/deleted vs HEAD, or vs the PR base in CI);
no DML without `-- harness-allow-dml: <reason>`; destructive DDL requires
`-- adr: docs/adr/<file>` pointing at an existing ADR. Pass by always generating a NEW
migration and following `docs/runbooks/expand-contract.md` for destructive phases.
**Anti-vacuity:** append a comment to an existing migration file (editor) → FAIL
append-only; add `DROP TABLE notes;` in a new migration without an ADR line → FAIL.

### 13. contracts — `node tools/check-contract-drift.mjs`

(1) OpenAPI regen-diff: `apps/server/scripts/emit-openapi.ts` (stable-stringified) must
equal the committed `apps/server/openapi.json` — pass with `pnpm openapi:emit` and
review the diff. (2) tsconfig project references mirror the workspace dependency graph.
**Anti-vacuity:** add a route without re-emitting → FAIL stale; delete a `references`
entry from a package tsconfig → FAIL naming the missing ref.

### 14. dead-code — `pnpm exec knip --strict`

Unused files, exports, and dependencies. Wire everything you add or delete it. NEVER
`knip --fix` (blocked): it auto-deletes with false positives.
**Anti-vacuity:** add an exported-but-unimported function → FAIL.

### 15. architecture — `pnpm exec depcruise apps packages --config .dependency-cruiser.cjs`

The dependency law: no cycles; desktop resolves no `postgres|drizzle-orm|pino|@hono/*`
nor anything in `apps/server`; drizzle confined to schema+server (drizzle-zod
schema-only); LLM SDK modules importable only from `packages/eval/src/adapters`.
**Anti-vacuity:** import a server module from a desktop file (editor — the write guard
also denies it in-session) → FAIL with the violation path.

### 16. build — `node tools/build-check.mjs`

`vite build` the desktop SPA, then grep the emitted `dist/` for forbidden markers
(ORM names, `MIGRATOR_DATABASE_URL`, connection-string prefixes, signing-material
references). The runtime backstop for gates 4/14: a transitive leak past static
analysis still shows up in the emitted JS.
**Anti-vacuity:** embed the literal string `MIGRATOR_DATABASE_URL` in a desktop
constant → build succeeds, gate FAILs on bundle purity.

### 17. rust-check — `node tools/run-rust-gates.mjs check`

`cargo check --locked` plus tauri-specta bindings drift (the export test regenerates
`apps/desktop/src/ipc/bindings.ts`; any git diff = stale committed bindings). Stamped:
`.harness/rust-check.ok` (sha256 over src-tauri + Cargo.lock) makes unchanged-Rust runs
instant locally; CI ignores the stamp. Clippy `-D warnings` runs in the CI rust lane.
**Anti-vacuity:** change a `#[tauri::command]` signature without committing regenerated
bindings → FAIL drift; introduce a type error in `lib.rs` → FAIL cargo check.

### 18. styleguide — `node tools/check-styleguide-manifest.mjs`

The design system is DATA (default-on since 0.1.3; formerly the gate-styleguide
module). Over the Tailwind v4 CSS-first theme in `apps/desktop/src/styles.css` and
`tools/styleguide.manifest.json` (write-guard-protected):

- **Erasure + closure.** Every erased namespace keeps its `--<ns>-*: initial` marker
  (Tailwind's default palette/scales can never silently return); `--color-*` tokens and
  every family (font/text/radius/shadow/ease) match the manifest bidirectionally; color
  tokens are OKLCH-only (one color model keeps lightness steps perceptually comparable
  and the contrast recomputable).
- **Theme closure** (conditional on `manifest.themes`). Each `themes.<name>.selector`
  names a `:root` override block in `styles.css` that must redeclare EXACTLY the token
  set — a token the theme forgets to override lets the base (dark) value paint through
  on the light canvas. Override values are plain `oklch()` literals (no alpha, no
  `var()`) so they stay convertible. v0.1.3 manifests without `themes` self-disable this.
- **Computed contrast** (conditional on `manifest.contrast`). Contrast is no longer
  prose in `styles.css`: for the base `@theme` AND every theme block, each
  `{fg,bg,min}` pair is CONVERTED through `tools/lib/oklch.mjs` — OKLCH → OKLab
  (polar→rectangular) → cube LMS → linear-light sRGB (CSS Color 4 reference matrices)
  → WCAG relative luminance (`0.2126R+0.7152G+0.0722B` on the linear channels) →
  `(Lhi+0.05)/(Llo+0.05)` — and asserted `>= min`. An out-of-gamut token FAILs
  'unverifiable' (the browser would gamut-map it, so its painted contrast is not the
  computed one). The numbers thus cannot drift from the token values.
  SOURCE: CSS Color 4 OKLCH→sRGB [corpus: csswg/oklch-srgb]; WCAG relative luminance
  [corpus: wcag/relative-luminance].
- **Source scan.** The desktop source carries no raw hex, no raw px, no inline
  `style={}`, no references to erased default-palette utilities (which compile to
  NOTHING — a silent no-op, worse than off-brand), and no Tailwind **arbitrary values**:
  the utility form `text-[#abc]`/`w-[13px]`, the bracket-property form
  `[mask-type:luminance]`, and the v4 shorthand `bg-(--var)` all smuggle off-token
  colors/lengths inline. The property-form check requires a non-whitespace char right
  after the colon — exactly the Tailwind grammar (arbitrary values encode spaces as `_`)
  — which precisely excludes prose bracket-colon forms, above all the mandatory
  `[corpus: <id>]` provenance citations in source comments. Extend the vocabulary in
  BOTH files, or add a reviewed `manifest.allow` file exemption.
- **Primitive boundary** (conditional on `manifest.controlPrimitives`). In `.tsx`
  files outside the declared primitives home (`apps/desktop/src/components`), a JSX
  open-tag for a declared control tag (`<button|input|select|textarea`) carrying a
  literal `className` is a hand-styled control — gate-red with a FIX line naming the
  primitive (Button/Input) to render through instead; new control styling goes INTO
  the primitive. The scan is textual like the hex/px scans (tag-open to the next `<`,
  so multi-line tags are covered; a spread-props className is undetected;
  over-matching — e.g. a commented-out tag — reds rather than fails open).
  `controlAllow: [{ file, reason }]` is the reviewed escape, separate from the px/hex
  `allow` list; malformed or STALE entries (file gone, or no live match) FAIL. The
  manifest is seeded, so a pre-0.1.5 manifest without the key self-disables with a
  NOTE naming `update --refresh-seeded tools/styleguide.manifest.json`.
- **Accent budget.** Accent-utility usage stays within the documented budget.

**Anti-vacuity:** delete an erasure marker → FAIL naming the namespace; add
`text-red-500` to any TSX → FAIL naming the file; add a hex literal or a `text-[#…]`
arbitrary value → FAIL; darken a light token below its floor → FAIL printing the
computed ratio (e.g. `accent on surface = 4.24:1 (min 4.5:1)`); push a token
out of the sRGB gamut → FAIL 'unverifiable'; drop a light-theme token override → FAIL
('the base value paints through'); hand-roll a `<button className=…>` in a screen →
FAIL with the primitive-naming FIX line; strip `controlPrimitives` from the manifest
→ NOTE + pass (the pre-0.1.5 shape).

### 19. perf-budget — `node tools/check-perf-budget.mjs`

Median-of-N `renderToString` wall time asserted against `tools/perf-budget.json`
(write-guard-protected — raising a budget is a reviewed human decision; the file is
SEEDED, so `update` never rewrites it). A red requires TWO independent over-budget
medians (one automatic re-measure), so scheduler noise cannot fail a turn while a
genuine 10× regression still cannot pass. Default-on since 0.1.3 (formerly the
gate-perf-budget module). THREE budget shapes, chosen by the JSON content:

- **`subjects[]` (the shipped 0.1.5 form).** `subjects: [{ subject, cells,
  medianBudgetMs, expect? }]` under one shared top-level `runs` (one measurement
  protocol per budget keeps medians comparable; there is deliberately no per-subject
  run count). Each entry is measured SEQUENTIALLY (wall-clock medians never share a
  CPU): the gate spawns `pnpm --filter desktop exec tsx tools/lib/perf-subject-cli.mjs
  <subject> <cells> <runs>` (shell:true for the Windows `.cmd` shims); tsx resolves
  react + react-dom/server from the desktop workspace and transpiles the TS import
  graph, so the gate measures the ACTUAL component, not a stand-in. The CLI does 2
  warmups + N timed `renderToString` runs, asserts each render contains the entry's
  `expect` marker (default `role="gridcell"`; passed via the `PERF_SUBJECT_EXPECT`
  env var — argv would be mangled by shell quoting), and prints one `{"samples":[…]}`
  line. **Fail, not fallback:** a missing subject file, unresolvable tsx, spawn
  failure, malformed CLI output, or a vacuous render is a hard FAIL with a named
  reason — the gate NEVER silently substitutes the synthetic measurement. Declaring
  `subject` AND `subjects` together is an ambiguity FAIL.

  This shape also arms the **dense-feature closure** rule: every
  `apps/desktop/src/features/*` dir whose `.ts`/`.tsx` files import the matrix hooks
  (`useVirtualWindow` / `useRovingGrid` — textual `from '…/useVirtualWindow'`
  specifier match, tolerant of relative/alias paths; no AST, so over-detection reds
  and can never fail-open green) must ship a `perfSubject.ts` declared in
  `subjects[]`; every declared file must exist; and every `features/*/perfSubject.ts`
  must be declared. `features/matrix/perfSubject.ts` is the worked pattern (an
  ISLAND: exports `renderSubject(cells): string`, imported only by its unit test and
  this gate's CLI — never reachable from `main.tsx`). The reviewed escape is
  `exempt: [{ dir, reason }]` (`dir` = the bare feature dir name); malformed or stale
  exempt entries FAIL, never fail open.
- **Legacy single `subject` (0.1.4 budgets).** Exactly the 0.1.4 single-subject
  behavior (no closure scan), plus a NOTE naming the `subjects[]` form and the
  deliberate adoption command: `npx tauri-postgres-agent-harness update
  --refresh-seeded tools/perf-budget.json`. A pre-0.1.4 install must pull
  `apps/desktop/src/features/matrix/` first, or the refreshed budget's matrix entry
  reds on a missing file.
- **Legacy synthetic (pre-0.1.4 budgets).** When neither key is present, the gate
  falls back to the in-process synthetic rows×cols fixture, byte-for-byte as it
  shipped in 0.1.3, resolving react via `createRequire` from `apps/desktop`.

**Calibration doctrine.** Each shipped budget is ~10× the locally-measured
fresh-scaffold median, rounded up to a clean number, so real features fit while a 10×
regression cannot — pin from the slower CI lane's median if a clean lane exists.
**Anti-vacuity:** the CLI's `expect`-marker assert makes an empty render exit 1;
slow the cell render 10× → FAIL twice-measured; declare a subject that does not
exist → FAIL naming it; add a features dir importing `useVirtualWindow` with no
`perfSubject.ts` → FAIL with the create-FIX line; leave a `perfSubject.ts`
undeclared → FAIL; malform an `exempt` entry → FAIL.

### 20. route-manifest — `node tools/check-route-manifest.mjs`

Every screen is REGISTERED: `apps/desktop/src/routes.ts` ROUTES must be non-empty;
every entry carries id/label/path/features + `states.{loading,empty,error}` test ids
(`e2e/states.spec.ts` drives each; the a11y sweeps iterate the same array); every
directory under `src/features/` is either referenced by an entry's `features` list or
allowlisted in `tools/route-allowlist.json` (write-guard-protected, reasons required).
Closure runs both ways — stale manifest/allowlist entries fail too. Beyond presence,
the gate checks the DATA is well-formed:

- **Path validity.** Each `path` matches `^/$|^/[a-z0-9-]+(/[a-z0-9-]+)*$` — a leading
  slash and lowercase kebab segments, no trailing slash (except root), whitespace,
  query, or hash. The router matches these literally, so a stray space or capital is a
  silently-dead route.
- **Path uniqueness.** No two entries share a `path` (a duplicate routes two screens to
  one URL) — the red names both ids.
- **State-id uniqueness.** State test ids are distinct within an entry AND globally
  unique across the manifest, so an e2e sweep can never assert against the wrong
  screen's DOM.

Static, <100ms: brace-depth entry split + per-field regex, not substring vibes.
**Anti-vacuity:** add `src/features/reports/` without a ROUTES reference → FAIL naming
the directory; empty the ROUTES array → FAIL ("vacuous pass"); drop `states.error` →
FAIL naming the entry and key; a malformed path (`matrix`, `/Matrix `, `/a//b`),
duplicate path, or reused state id → FAIL naming the offender; malformed allowlist JSON
→ the gate itself fails, never open.

### 21. e2e — `node tools/check-e2e.mjs`

The agent-time Playwright lane: runs the whole `e2e/` directory (a11y + states +
degraded-network) in chromium against `vite dev` — the same suite CI runs. Chromium
presence is detected from playwright's own registry (`chromium.executablePath()` +
existsSync); absent → loud local skip with the exact install command
(`pnpm exec playwright install chromium`), CI → fail closed. Hard 10-minute kill;
the last 50 output lines surface on failure. Stamped — the single biggest warm-validate
win: `.harness/e2e.ok` (sha256 over `e2e/`, `playwright.config.ts`, the desktop app
`src`/`index.html`/`public`/configs, `packages/schema/src`, and `pnpm-lock.yaml`)
short-circuits a warm unchanged run in ms, *before even resolving Playwright*, instead
of re-running the whole browser suite. The stamp records ONLY after a real run passes
including the anti-vacuity check below, so a vacuous run never stamps. Staleness
analysis of the deliberate exclusions: `apps/server` is stubbed by the e2e IPC mocks;
`src-tauri` is mocked and its committed specta bindings already live inside
`apps/desktop/src`; `packages/importer`/`packages/eval` are unreachable from the
desktop graph by depcruise + bundle purity — none can change a desktop e2e verdict, so
omitting them cannot ride a stale green. CI always re-runs.
**Anti-vacuity:** an exit-0 run reporting zero passing tests FAILS ("an empty e2e run
is a vacuous pass"); break a state test id or remove the `:focus-visible` outline →
the suite (and thus the gate) reds.

### 22. docs-sync — `node tools/check-docs-sync.mjs`

The agent-facing documentation cannot lie about the gate: CLAUDE.md stays a pure
`@AGENTS.md` include; the AGENTS.md "The N gates, in order: ..." sentence must match
`VALIDATE_STEPS` exactly (names, order, count — the release-time doc sweep becomes
mechanical); every `pnpm <script>` command AGENTS.md advertises must exist in the root
package.json scripts; and every `VALIDATE_STEPS` name has its own numbered section
(`### <n>. <name> — `) in THIS catalog — the anti-vacuity record is part of the gate,
so an undocumented step cannot ship. The catalog check is version-ramped: on an
install whose `baseVersion` predates 0.1.5 it reports NOTE-only (a consumer's custom
step must not go red on the update that shipped the check — graduate via
`docs/runbooks/harness-upgrade.md`); fresh installs run it live.

The agent roster is part of the same surface: every `.claude/agents/*.md` must parse
under the pinned frontmatter grammar (`tools/lib/agent-roster.mjs` — a deliberate YAML
subset; a parse failure is a RED, never a skip, because an unreadable reviewer could
hide a write grant) and carry `name` (matching its filename), `description`, and
`model`. The five reviewer agents (`security-reviewer`, `torvalds-reviewer`,
`accessibility-reviewer`, `tauri-security-reviewer`, `citation-verifier`) may hold
ONLY the read-only allowlist (`Read`, `Grep`, `Glob`, `WebFetch`, `mcp__rls_verify`,
`mcp__corpus_search`) and must disallow `Write` + `Edit` — the README's "read-only by
construction" claim, machine-asserted (the harness repo mirrors the same check over
the shipped roster in its own CI). Author agents keep their write tools; only the
universal fields apply to them. The roster sub-check is deliberately NOT
version-ramped: the agent files are harness-owned, so the update that ships the check
refreshes the roster with it — only a hand-widened reviewer reds, and that is the point.
**Anti-vacuity:** add a gate to VALIDATE_STEPS without touching AGENTS.md → FAIL
printing documented-vs-actual chains; advertise `pnpm ghost` → FAIL naming it;
rename or delete a numbered catalog section (e.g. this one) → FAIL naming the
undocumented gate; grant `security-reviewer` Bash, drop a reviewer's
`disallowedTools`, or rewrite its frontmatter as a block sequence → FAIL naming
the agent, the offending grant, and the doctrine.

### the validate runner — serial by default, pooled under `--report-all`

`node tools/validate.mjs` runs the chain above strictly serially with streamed output,
stopping at the first failure — the fast agent edit-loop (one red, one fix). This mode
is byte-for-byte unchanged from earlier releases. The Stop hook instead passes
`--report-all` so an agent sees EVERY red at once; there, maximal runs of consecutive
read-only gates (the `PARALLEL_SAFE` set: provenance, tauri-policy, version-sync,
prompts, licenses, schema-rls, migrations, contracts, styleguide, route-manifest,
docs-sync) execute in a small pool (size `max(1, min(4, cores−1))`), with each child's
stdout+stderr captured and flushed in CANONICAL order, so the report always reads
top-to-bottom regardless of finish order. Any step NOT in that set runs exclusive
(serial, streamed): the build/rust-check/e2e gates, `perf-budget` (a wall-time render
measurement that CPU contention would flake red), and any consumer-added custom step —
an unknown step is never assumed pool-safe. `provenance` and `migrations` share a `git`
resource key so they never race `.git/index.lock` inside a batch. Per-step elapsed ms,
the summary block, and the exit aggregation are identical across both modes.

## Stop-hook runtime suites (`STOP_HOOK_STEPS`)

### rls-isolation — `node tests/rls/run-rls.mjs`

Live cross-user isolation against local Postgres (fresh-applies all migrations first).
Seeded positive control (a deny-all database must NOT pass), zero-row cross-user
SELECT/UPDATE/DELETE, SQLSTATE 42501 on INSERT smuggling, pooled-connection GUC-leak
detector (pool max=1), and the pg_catalog gate (FORCE RLS flags, per-op policies,
leading-column owner indexes, initPlan-shaped predicates from `pg_policies`, patched
pgvector, non-BYPASSRLS role). The plan-regression probe
(`tests/rls/plan-regression.test.ts`) then bulk-seeds 10k rows across 1k synthetic
owners as the migrator with FORCE lifted for one transaction (FORCE binds the owner
too; ANALYZE needs the owner), pins stats, and asserts via plain
`EXPLAIN (FORMAT JSON)` as `app_api`
that each target is reached through its owner index with a once-per-statement
InitPlan — no Seq Scan, no per-row SubPlan. Full doctrine: README "RLS testing
doctrine".
**Anti-vacuity:** three distinct injections — (a) drop one policy in a new migration →
catalog gate + isolation matrix FAIL; (b) break `withUser` to skip `set_config` → the
positive control fails (nothing visible), proving the suite cannot green vacuously;
(c) change `set_config(..., true)` to `false` in a scratch copy → the GUC-leak test
fails.

### unit — `pnpm exec vitest run --coverage --silent`

The behavioral net: both projects (`unit-node`, `unit-dom`), including the
keyboard-registry WCAG 2.1.4 test, auth clock-skew (±4 pass / ±6 fail) and
production+stub boot-fatal tests, skew-middleware route-coverage walk, SSE abort
propagation, EMBEDDING_DIM assert, importer property tests, and the eval fixture scorer.
`--coverage` additionally enforces the AGGREGATE thresholds in `vitest.config.ts`
(70/60/65/70) and writes `coverage/coverage-final.json` — the artifact the next
step reads.
**Anti-vacuity:** register a bare single-character global shortcut in
`src/keyboard/registry.ts` → the WCAG test fails; drop a large untested module →
the aggregate threshold reds the run.

### diff-coverage — `node tools/check-diff-coverage.mjs`

Per-file coverage floors on every CHANGED source file, closing the wash the
aggregate cannot see: a 0%-covered new module hides comfortably inside a green
70% total. Changed = merge-base diff against the PR base in CI; worktree vs
HEAD + staged + untracked source files locally (an agent's brand-new
uncommitted feature file is exactly the case that must not slip). Each changed
`apps/*/src` / `packages/*/src` code file must be present in the
`coverage/coverage-final.json` the `unit` step just wrote (absent = no test
imports it) and clear the `PER_FILE_FLOORS` in `vitest.config.ts` — parsed
from that write-guard-protected config fail-closed, never duplicated. Test
files, `.d.ts`, and the config's `COVERAGE_EXCLUDE` entries (generated
bindings, boot wiring, the live-db surface the RLS suite proves instead) are
exempt. An empty diff passes with a one-line note — which is what makes the
step inherently ramp-safe on upgraded installs — but a missing
coverage-final.json FAILS CLOSED: the chain was reordered or the artifact
deleted.
**Anti-vacuity:** add an untracked `apps/server/src/` file with an exported
function and no test → FAIL naming the file as absent from the coverage map;
`tests/gates/check-diff-coverage.test.mjs` additionally pins the below-floor
red, the at-floor green, and the fail-closed missing-artifact path.

## Opt-in modules

`npx tauri-postgres-agent-harness enable <module>` copies the module's files and records
it in `.harness/manifest.json`. Most modules are pure file-drops (a workflow that is
live the moment it lands). The two validate-chain gate modules need one more step:
uncomment their entry in `tools/harness.config.mjs` — write-guard-protected, so a human
sets `HARNESS_ALLOW_SELF_EDIT=1` or edits outside an agent session (the installer prints
this hint on enable).

Tiers: `core` = none, `standard` = ci-provenance + ci-windows-release, `strict` = all.
Retired: `gate-styleguide` and `gate-perf-budget` were promoted into the default
chain in 0.1.3 (gates 18–19 above); `enable` refuses them and `update` migrates
existing installs.

| Module | What it adds | Why not default-on |
|---|---|---|
| `ci-windows-release` | the signed-release DAG: sign (Azure Trusted Signing) → `signtool verify /pa /all` → NSIS `/S` silent install/uninstall smoke → Defender scan with `-DisableRemediation` → determinism spot-check → checksums + `latest.json` → release automation; installer size budget | needs signing credentials, a Windows runner budget, and a release cadence |
| `ci-windows-e2e` | WebDriver E2E on Windows incl. enterprise-net simulation: TLS-intercepting-proxy smoke (private CA in the machine store), redirected-APPDATA, >280-char paths, WebView2 ProcessFailed kill/recover | slow Windows runners; needs the built binary, not the dev server |
| `ci-macos` | macOS build lane (development smoke; Windows stays the release target) | pays only if contributors develop on macOS |
| `ci-provenance` | SBOM for both ecosystems (npm + crates) + build attestation + verification step + NOTICES drift check | meaningful once artifacts ship to a consumer who verifies them |
| `mutation` | StrykerJS incremental per-PR on critical TS modules + `cargo-mutants --in-diff` for the Rust host | minutes-to-hours; pays off once there is authz/money logic worth mutating |
| `gate-a11y-deep` | route-manifest axe (WCAG 2.2 AA) + keyboard traversal + screen-reader checklist | needs real routes and a browser lane; the default keyboard-registry test already holds 2.1.4 |
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
- **Playwright-trace interaction budget on a pinned runner** — deferred: an absolute
  UX latency metric (input→paint) needs a dedicated pinned CI runner to be stable,
  whereas `perf-budget`'s relative render canary catches regressions cheaply with no
  browser; revisit if a hosted runner class with pinned CPU lands.
