# Changelog

All notable changes to the harness are documented here. Consuming projects
pick up fixes with `npx --yes github:BhodiSea/tauri-postgres-agent-harness update`.

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
