# Changelog

All notable changes to the harness are documented here. Consuming projects
pick up fixes with `npx --yes github:BhodiSea/tauri-postgres-agent-harness update`.

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
