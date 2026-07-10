# Changelog

All notable changes to the harness are documented here. Consuming projects
pick up fixes with `npx --yes github:BhodiSea/tauri-postgres-agent-harness update`.

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
