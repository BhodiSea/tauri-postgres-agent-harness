import { defineConfig } from 'vitest/config'

// Root Vitest config — the ONLY vitest config (BUILD-SPEC §Vitest). Three projects:
//   unit-node: packages/* + apps/server, plain node environment
//   unit-dom:  apps/desktop component/unit tests under jsdom
//   rls:       tests/rls/** — the isolation suite. It self-skips politely unless
//              RLS_SUITE_READY=1, which only `node tests/rls/run-rls.mjs` sets after
//              fresh-applying migrations to a real Postgres (and which FAILS CLOSED
//              in CI). Plain `vitest run` therefore stays green without a database.
// Tests are colocated as *.test.ts(x) or live under <workspace>/tests/unit/.

// Source files the UNIT-coverage bar cannot measure honestly — excluded from
// coverage AND from the diff-coverage gate (tools/check-diff-coverage.mjs parses
// THIS array, so the two surfaces cannot drift):
//   - generated code (the tauri-specta bindings) is not hand-written surface
//   - process boot wiring (desktop main.tsx, server index.ts) runs only in a real host
//   - the live-database surface (db/client.ts, db/context.ts) is deliberately
//     unreachable by unit tests (they never open a connection — determinism
//     doctrine); the RLS isolation suite in the same Stop chain proves it
//     against real Postgres instead.
const COVERAGE_EXCLUDE = [
  '**/*.d.ts',
  'apps/desktop/src/ipc/bindings.ts',
  'apps/desktop/src/main.tsx',
  'apps/server/src/index.ts',
  'apps/server/src/db/client.ts',
  'apps/server/src/db/context.ts',
]

// Per-file coverage floors — deliberately BELOW the aggregate thresholds: their
// one job is making an untested file impossible (a 0% file hides comfortably
// inside a green 70% aggregate). Vitest cannot enforce an aggregate bar and a
// per-file bar in the same run (thresholds.perFile is a single global switch),
// so the '**/*' glob entry below pins these numbers where vitest tolerates them
// (an all-files group at lower numbers than the global bar can never
// independently fail), and tools/check-diff-coverage.mjs — the Stop-chain step
// right after `unit` — enforces them PER CHANGED FILE from
// coverage/coverage-final.json. Calibrated on the fresh scaffold (lowest shipped
// file per metric: statements 63 / branches 44 / functions 50 / lines 67);
// raising floors as real coverage grows is a reviewed human decision — this
// config is write-guard-protected.
const PER_FILE_FLOORS = {
  statements: 50,
  branches: 40,
  functions: 45,
  lines: 50,
}

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**'],
      exclude: COVERAGE_EXCLUDE,
      // The vitest defaults, pinned explicitly because a sibling gate depends on
      // one of them: `json` writes coverage/coverage-final.json, the artifact
      // tools/check-diff-coverage.mjs reads.
      reporter: ['text', 'html', 'clover', 'json'],
      // Aggregate floor, enforced wherever `--coverage` runs (the Stop hook's unit
      // step and CI): calibrated ~5-10 points under the fresh-scaffold measurement
      // so shipped code starts green while a feature landing without tests turns
      // the gate red. Raising floors as real coverage grows is a reviewed human
      // decision — this config is write-guard-protected.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 65,
        lines: 70,
        '**/*': PER_FILE_FLOORS,
      },
    },
    projects: [
      {
        test: {
          name: 'unit-node',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/tests/unit/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/server/tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          // Determinism: RTL cleanup after every test + a pending-forever fetch
          // stub (unit tests never touch the network) — see the setup file.
          setupFiles: ['apps/desktop/src/test-setup.ts'],
          include: [
            'apps/desktop/src/**/*.test.{ts,tsx}',
            'apps/desktop/tests/unit/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        test: {
          name: 'rls',
          environment: 'node',
          include: ['tests/rls/**/*.test.ts'],
        },
      },
    ],
  },
})
