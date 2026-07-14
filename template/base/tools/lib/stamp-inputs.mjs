// Declared stamp inputs per stamped gate (see stampGate in lib/gate.mjs) — this is
// REVIEWED DATA: an input class missing from a gate's list means edits to it could
// ride a stale green stamp locally (CI always re-runs, so nothing ships wrong, but
// the Stop hook would under-check). The selftest mutates a representative of each
// class and asserts the stamp invalidates; extend BOTH together.
// SOURCE: docs/harness/README.md (rust gates; stamp) [corpus: harness/doctrine]
export const STAMP_INPUTS = {
  // vite build + bundle purity + byte budgets + the gzip ratchet baseline
  // (tools/perf-baseline.json is declared even where absent: the missing-path
  // token means the baseline APPEARING — e.g. `pnpm perf:baseline` — also
  // invalidates a warm stamp, so the ratchet arms on the very next validate).
  build: [
    'apps/desktop/src',
    'apps/desktop/index.html',
    'apps/desktop/package.json',
    'apps/desktop/vite.config.ts',
    'apps/desktop/tsconfig.json',
    'tools/bundle-budget.json',
    'tools/perf-baseline.json',
    'pnpm-lock.yaml',
  ],
  // openapi regen-diff + tsconfig project-references sync
  contracts: [
    'apps/server/src',
    'apps/server/scripts',
    'apps/server/openapi.json',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
    'apps/desktop/package.json',
    'apps/desktop/tsconfig.json',
    'packages',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'knip.json',
  ],
  // the whole Playwright lane (a11y + states + degraded-network). Deliberate
  // exclusions: apps/server is stubbed by the e2e mocks (mock-ipc); src-tauri is
  // mocked and the committed specta bindings live INSIDE apps/desktop/src (already
  // covered); packages/importer + packages/eval are unreachable from the desktop
  // graph by depcruise + bundle purity, so they cannot change a desktop e2e verdict.
  // CI always re-runs (inCI), so nothing under-tested ever ships.
  e2e: [
    'e2e',
    'playwright.config.ts',
    'apps/desktop/src',
    'apps/desktop/index.html',
    'apps/desktop/public',
    'apps/desktop/vite.config.ts',
    'apps/desktop/package.json',
    'apps/desktop/tsconfig.json',
    'packages/schema/src',
    'packages/schema/package.json',
    'pnpm-lock.yaml',
  ],
  // pnpm license metadata + the exception list
  // + the citeability surface (G25): LICENSE and CITATION.cff are gate inputs now, so a
  // drifted citation version can never ride a warm stamp.
  licenses: [
    'pnpm-lock.yaml',
    'package.json',
    'tools/license-exceptions.json',
    'LICENSE',
    'CITATION.cff',
  ],
  // the Rust host + the committed specta bindings it must stay in sync with
  'rust-check': [
    'apps/desktop/src-tauri',
    'apps/desktop/src/ipc/bindings.ts',
    'rust-toolchain.toml',
  ],
  // one-version-everywhere + node-major agreement + rc-pin + single-zod-instance.
  // Every version the gate reads (root/tauri.conf/server/desktop), both node-version
  // files, and the catalog. The zod single-instance check reads the INSTALLED graph,
  // but that graph is fully determined by pnpm-lock.yaml — hashing the lockfile (not
  // node_modules) captures every resolution that could flip the verdict, and lets a
  // warm run skip WITHOUT spawning `pnpm list -r`. CI always re-runs.
  'version-sync': [
    'package.json',
    'apps/desktop/package.json',
    'apps/server/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
    '.nvmrc',
    '.node-version',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ],
}
