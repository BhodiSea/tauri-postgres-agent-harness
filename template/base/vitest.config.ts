import { defineConfig } from 'vitest/config'

// Root Vitest config — the ONLY vitest config (BUILD-SPEC §Vitest). Three projects:
//   unit-node: packages/* + apps/server, plain node environment
//   unit-dom:  apps/desktop component/unit tests under jsdom
//   rls:       tests/rls/** — the isolation suite. It self-skips politely unless
//              RLS_SUITE_READY=1, which only `node tests/rls/run-rls.mjs` sets after
//              fresh-applying migrations to a real Postgres (and which FAILS CLOSED
//              in CI). Plain `vitest run` therefore stays green without a database.
// Tests are colocated as *.test.ts(x) or live under <workspace>/tests/unit/.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**'],
      // Coverage floor, enforced wherever `--coverage` runs (the Stop hook's unit
      // step and CI): calibrated ~5-10 points under the fresh-scaffold measurement
      // so shipped code starts green while a feature landing without tests turns
      // the gate red. Raising floors as real coverage grows is a reviewed human
      // decision — this config is write-guard-protected.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 65,
        lines: 70,
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
