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
