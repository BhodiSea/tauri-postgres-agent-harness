# Changelog

All notable changes to the harness are documented here. Consuming projects
pick up fixes with `npx --yes github:BhodiSea/tauri-postgres-agent-harness update`.

## [0.1.4] — 2026-07-11

The four pillars deepened. The reference UI becomes a real gate subject (a
virtualized matrix exemplar, shared primitives, light/dark parity with
**computed** WCAG contrast), the machinery is deduplicated and unit-tested
(205 → 558 harness tests), and warm validate drops to ≈5 s for all 22 gates
(stamped e2e, pooled report-all) — measured cold ≈76 s with real cargo +
30 chromium e2e tests on the fresh scaffold.

**What `update` does for an existing install** (lead story): all owned gate
scripts, hooks, e2e specs, and the corpus refresh as usual. The ~28 new seeded
desktop exemplar files (features/matrix, screens/, theme/, router, the
component primitives) are **withheld** — a new `seedOnInitOnly` migration kind
stops `update` from planting files your seeded `routes.ts` never references
(which would red route-manifest + dead-code). Each withheld cluster emits a
note; pull on your terms with `update --refresh-seeded <path>` (now accepts
directory prefixes). After pulling `features/matrix`, register the screen in
`routes.ts` (or pull the new `routes.ts` too — pristine seeded files refresh,
drifted ones park) — route-manifest's FIX line walks you through it. The new
styleguide/perf-budget checks self-disable on pre-0.1.4 manifests, except the
arbitrary-value scan (tokens-only hardening; `allow` entries are the escape).

- **UI/UX**: shared `src/components` primitives (Button/Input/Skeleton/Toast/
  EmptyState) replace four hand-repeated inline button styles (accent usage
  4/10 of budget); light + dark themes with `prefers-color-scheme` tracking, a
  persisted three-state toggle, palette commands, and a dark launch frame in
  both themes (anti-flash, lockstep with tauri.conf backgroundColor); explicit
  `prefers-reduced-motion` support; a hand-rolled router with a lazy-loaded
  second route; and `features/matrix` — the doctrine's data-dense exemplar:
  pure virtual-window math, an APG roving-tabindex grid reporting
  `aria-rowcount` over a windowed DOM, keyset pagination wired to the server's
  `{ items, nextCursor }` contract, and a hand-rolled SVG summary strip.
- **Styleguide gate computes contrast**: the prose contrast table in styles.css
  is replaced by `tools/lib/oklch.mjs` (CSS Color 4 conversion → WCAG relative
  luminance) verifying every manifest-declared fg/bg pair in BOTH themes —
  6 pairs computed green (the shipped light accent was out of sRGB gamut and
  failing 4.5:1 as text; retuned to `oklch(0.475 0.08 200)`). Theme-block token
  closure (a light override missing a token fails loudly), and Tailwind
  arbitrary-value escapes (`w-[13px]`, `[prop:value]`, `-(--var)`) are gate-red.
- **perf-budget measures the real component**: `budget.subject` spawns
  `features/matrix/perfSubject.ts` under tsx (median-of-7 renderToString of the
  actual 10k-cell grid, ~40 ms local, budget 500 ms), anti-vacuous
  (`role="gridcell"` asserted), and an unresolvable subject FAILS — never a
  silent synthetic fallback. route-manifest adds canonical-path validity,
  duplicate-path, and state-test-id uniqueness checks.
- **e2e lane 15 → 30 tests**: every route axe-swept in BOTH themes; a
  reduced-motion lane proving the held loading skeleton runs zero animations
  (with a no-preference control proving the assert can red); a matrix lane
  proving single-tab-stop roving focus, real virtualization, and cursor
  forwarding. 3× consecutive runs flake-free; `retries` stays 0.
- **Warm validate ≈5 s**: the e2e and version-sync gates are content-hash
  stamped (a vacuous run never stamps; CI always re-runs — the selftest warm
  lane greps the stamp skip as a positive control), and `--report-all` (the
  Stop-hook path) runs the 11 read-only gates through a concurrency pool with
  canonical-order output. Cold ≈76 s (rust-check dominates at ~51 s).
- **FLOOR is a frozen snapshot**: `tools/validate.floor.json` replaces the
  hand-copied array in validate.mjs — `--min-floor` fails CLOSED on a missing/
  corrupt snapshot, `scripts/generate-floor.mjs --check` + a data-to-data test
  end the hand-sync, and the file is write-guard protected (34 → 33 real
  patterns + 1: the old count regex had been counting two comment lines).
- **Guard rules are data with per-rule falsifiability**: both guards load their
  tables from `hooks/lib/guard-rules.mjs` (import failure = BLOCKED, exit 2);
  check-canary-coverage asserts every one of the 56 rule ids has a behavioral
  deny/allow canary (three brittle count-regexes deleted; closure surfaced
  three previously untested rules: fork-bomb, drizzle-kit-drop,
  minisign-secret-key) and pins the inline denyTool call-site counts.
- **Fixed (fail-open)**: the provenance sweep's git pathspecs silently skipped
  files directly under `apps/` and `packages/` (`apps/**/*.ts` requires an
  intermediate directory) — `gateFileMatch()` widens the sweep fail-closed and
  one bare `git ls-files` serves both sweeps.
- **Machinery quality**: one dirent-based walker per side replaces ~12 drifted
  copies (directory-only pruning; a broken symlink can no longer crash
  doctor's scan); `writeInstallFile` re-asserts the executable bit on
  overwrite; update's plan loop and refresh-seeded share one pure
  `classifyDrift()`; doctor renders only seeded entries and `--refresh-seeded`
  renders only the requested paths. 558 harness tests (was 205): logic-level
  suites for 8 previously canary-only gates, 9 untested installer libs, hookio
  fail-closed contracts, and a pinned digest vector guarding stamp inputs.
  New CI floors: tools-lib 90/85/85; update-skew is now a [v0.1.1, v0.1.3]
  matrix asserting route-manifest green on the 0.1.3 leg.
- **Docs honesty**: README module list 12 → 10 (the two retired-in-0.1.3
  modules removed; stub-core modules now say what ships wired vs. as a seam);
  CITATION.cff carries version + date-released and check-release-lockstep
  asserts both plus the CHANGELOG section on every PR.

## [0.1.3] — 2026-07-10

The four-pillar milestone: the default chain grows 16 → **22 gates**, every gate
is provably able to fail, and `update` becomes a real cross-version vehicle.
Existing installs receive everything via `update` (gate steps are injected into
the consumer's config, promoted modules fold in, canonical commands heal).

- **New default gates**: `gate-integrity` (sha over the enforcement surface),
  `styleguide` (tokens-only design system — erased Tailwind palette, no raw
  hex/px/inline styles, family closure, accent budget), `perf-budget`
  (median-of-N render budget, re-measure-once), `route-manifest` (every screen
  registered with loading/empty/error states; features-dir closure), `e2e` (the
  whole Playwright lane — axe per state, keyboard walk with computed
  focus-visibility, focus traps — at agent time), `docs-sync` (AGENTS.md gate
  list must equal the chain). `gate-styleguide`/`gate-perf-budget` modules are
  retired (promoted); `enable` explains the promotion.
- **RLS performance is enforced**: owner columns need a leading-column index
  (static gate + pg_catalog check + a 10k-row EXPLAIN plan probe asserting
  index access with a once-per-statement InitPlan — no Seq Scan, no per-row
  SubPlan). The RLS suite now runs on a scratch database (`<db>_rls`) under an
  advisory lock — test runs can no longer drop dev data, and concurrent runners
  serialize instead of corrupting each other.
- **Server exemplar hardened**: one error envelope
  (`{ error: { code, message, requestId } }`) with declared 4xx/5xx everywhere,
  `.max()` bounds on every wire string, `bodyLimit`, keyset pagination
  (`{ items, nextCursor }`, microsecond-faithful cursors) with an unconditional
  DAL LIMIT, a typed drizzle DAL (driver confined to `db/client`, context
  DAL-only — depcruise-enforced), and a statement-count invariance test that
  makes the N+1 class unable to land silently.
- **Trustworthy gates**: the schema-rls parser is statement-level (the v0.1.1
  regex was defeated by the shipped migration's own syntax), provenance
  citations must RESOLVE against a sha-pinned corpus covering every decision
  group, the Stop hook fails CLOSED when an RLS surface exists and no database
  is reachable (after auto-starting docker compose), and every failure carries
  a `FIX[gate]:` line with the exact reproduce command.
- **Falsifiability closure**: `tests/canary/injections.json` registers a
  mechanical red-proof for all 25 steps (validate ∪ Stop chains);
  `scripts/check-canary-coverage.mjs` reds any PR adding a gate without a
  canary or a hook rule without a deny test.
- **Feedback + speed**: `validate --report-all` (the Stop hook shows every red
  at once), per-step elapsed-ms, `eslint --cache`, and content-hash stamps that
  make warm `build`/`contracts`/`licenses`/`rust-check` skip in milliseconds
  (CI always re-runs). Coverage floors run in the Stop hook
  (`vitest run --coverage`) and over the installer itself in CI.
- **Installer**: cross-version migrations (removed/renamed/promotedModules/
  configSteps/configCommandUpdates), `update --refresh-seeded <path>`
  (park-on-drift channel for template improvements to project-owned files),
  doctor advisories (seeded divergence, parked upgrades, dormant lefthook),
  POSIX-normalized manifests with a Windows unit-test matrix, and a module
  render lane proving every module ships placeholder-clean and syntax-valid.
- **Fixed**: ci-windows-e2e drove a nonexistent `<productName>.exe` (Tauri 2
  names the binary after the Cargo bin — `desktop.exe`); the provenance sweep
  ENOBUFS-crashed on large trees (64 MB buffer); pnpm's CI banner polluted the
  openapi regen diff (`--silent`); a jsdom teardown race in the desktop unit
  tests (network-stubbed test setup + RTL cleanup).
- **Fixed**: the e2e lane was timing-flaky on animated loading states — axe
  blends animated opacity into its color-contrast math, so a pulsing skeleton
  read 4.42:1 or 7.8:1 depending on when the snapshot landed. The shipped
  Playwright config now emulates `prefers-reduced-motion` (freezing
  `motion-safe:` utilities), so axe always measures the true resting contrast.
- **Fixed (Windows)**: on native-Windows sessions the write-guard derived the
  project-relative path without normalizing separators, so every root-anchored
  PROTECTED pattern silently failed OPEN — backslash paths now normalize to
  POSIX before matching, and the bash-guard's protected-surface patterns accept
  both separators (deny tests cover the Windows spellings). Also: the
  source-check hook scanned generated bindings on Windows (same separator bug),
  and absolute-path dynamic `import()`s crashed the new Windows unit lanes
  (`pathToFileURL` everywhere).

## [0.1.1] — 2026-07-10

Windows fixes surfaced by the v0.1.0 selftest matrix. The npx channel was
unaffected (tarballs ship LF); the GitHub-template channel on Windows was not.

- **Fixed**: repo-root `.gitattributes` pinning `eol=lf`. Without it, Windows
  clones (CI runners, "Use this template" checkouts) got CRLF working trees,
  the installer copied that verbatim, and the scaffold's biome format gate
  failed on every file. `template/base` already shipped one for consumers;
  the harness repo itself lacked it.
- **Fixed**: tauri-build-smoke asserted the installed binary was
  `<productName>.exe`, but Tauri 2 names it after the Cargo bin
  (`desktop.exe`). The NSIS build, silent install, and uninstall were all
  correct — only the assert was wrong. It now checks for any app exe that
  isn't the uninstaller.
- **Fixed**: the smoke job's path filter now includes `selftest.yml` and
  `.gitattributes` — edits that change the smoke result re-run it instead of
  waiting for the nightly.
- **Fixed**: the provenance gate silently under-scanned on POSIX — `execSync`
  let the shell expand `apps/**/*.ts` before git saw it, and any pattern with a
  shallow match collapsed to just those files, dropping the deep tree from the
  scan. Windows `cmd` (which does not glob) scanned everything and exposed 12
  uncited decision sites the POSIX runs had been missing. The gate now uses
  `execFileSync` (no shell, identical on every platform) and the template
  carries citations at all 12 sites.
- **Fixed**: `.github/actionlint.yaml` ships with the template (and is staged
  in the harness's own lint fixture) declaring the `gpu` self-hosted runner
  label used by the eval-live module — actionlint no longer fails on it.
- **Fixed**: plugin manifest `agents` now lists the eight agent files
  explicitly (the validator rejects a bare directory path for `agents`);
  marketplace manifest gained a `metadata.description`. `claude plugin
  validate` passes clean.
- **Fixed**: Windows path separators in the prompts and contracts gates —
  `join()`/`relative()` output was compared against POSIX lock keys and
  tsconfig reference paths, so every prompt read as "not in the lock" and
  every project reference as missing. Both normalize to POSIX at the
  comparison boundary now.
- **Fixed**: the bindings-export sub-check of `rust-check` skips loudly on
  Windows when the test executable dies at load with
  `STATUS_ENTRYPOINT_NOT_FOUND` (the test binary links the full
  tauri/wry/WebView2 runtime without an embedded app manifest — a loader
  quirk, not a bindings problem). `cargo check --locked` still runs, and
  drift stays fail-closed on Linux CI for every PR.

## [0.1.0] — 2026-07-10

Initial release.

- **Installer**: `init` (bootstrap + retrofit with merge-never-clobber semantics,
  pnpm-workspace glob-union merge, Buffer-safe binary assets), `update`, `doctor`
  (raw-byte manifest hashing, hook version stamps, `@AGENTS.md` include check),
  `enable`/`disable` for 12 opt-in modules across core/standard/strict tiers.
- **Enforcement**: 5 fail-closed Claude Code hooks (bash guard, write guard with
  append-only migrations + Tauri surface content checks + GUC discipline, provenance
  check, single-file format feedback, Stop validate-gate), 43 contract tests.
- **Gate chain**: 16 config-driven steps mirrored by a hardcoded CI floor —
  biome, rustfmt, `tsc -b`, strictTypeChecked eslint, provenance, tauri-policy,
  version-sync, prompt locks, license allowlist, schema-RLS manifest, migration
  discipline, contract drift, knip strict, dependency-cruiser, vite build with
  bundle-purity grep, stamped `cargo check` + specta bindings drift.
- **Runtime proof**: plain-Postgres RLS isolation suite with seeded positive
  controls, SQLSTATE 42501 asserts, GUC-leak detector, pg_catalog gate; fresh-apply
  migration runner; `rls_verify` + `corpus_search` MCP servers.
- **Reference stack**: Tauri 2 (isolation pattern, offline WebView2, committed
  specta bindings, keyboard registry with WCAG 2.1.4 test, OKLCH tokens), Hono
  server (Entra/stub auth with production-fatal stub, version-skew middleware,
  SSE with abort propagation, server-only DAL), Drizzle schema + pgvector,
  zero-dep importer with fast-check, fixture-scored eval package.
- **CI**: selftest matrix (bootstrap ubuntu + windows-every-PR, canary
  inject-and-fail per gate, retrofit non-clobber, nightly Windows `tauri build`
  with silent-install smoke), shipped template workflows (quality-gate with Rust +
  RLS + Playwright mock-IPC lanes, migration-safety, api-contract, adr-guard,
  CodeQL, osv over both lockfiles, gitleaks, actionlint + zizmor), all SHA-pinned.
- Verified: 16/16 gates + full Stop chain green on a from-scratch scaffold
  (warm validate ≈ 7s); 69/69 harness self-tests.
