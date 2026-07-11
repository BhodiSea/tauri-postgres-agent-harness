// Declared stamp inputs per stamped gate (see stampGate in lib/gate.mjs) — this is
// REVIEWED DATA: an input class missing from a gate's list means edits to it could
// ride a stale green stamp locally (CI always re-runs, so nothing ships wrong, but
// the Stop hook would under-check). The selftest mutates a representative of each
// class and asserts the stamp invalidates; extend BOTH together.
// SOURCE: docs/harness/README.md (rust gates; stamp) [corpus: harness/doctrine]
export const STAMP_INPUTS = {
  // vite build + bundle purity + byte budgets
  build: [
    'apps/desktop/src',
    'apps/desktop/index.html',
    'apps/desktop/package.json',
    'apps/desktop/vite.config.ts',
    'apps/desktop/tsconfig.json',
    'tools/bundle-budget.json',
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
  // pnpm license metadata + the exception list
  licenses: ['pnpm-lock.yaml', 'package.json', 'tools/license-exceptions.json'],
  // the Rust host + the committed specta bindings it must stay in sync with
  'rust-check': [
    'apps/desktop/src-tauri',
    'apps/desktop/src/ipc/bindings.ts',
    'rust-toolchain.toml',
  ],
}
