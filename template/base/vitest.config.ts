import { defineConfig } from 'vitest/config'

// Root Vitest config — the ONLY vitest config (BUILD-SPEC §Vitest). Two projects:
//   unit-node: packages/* + apps/server, plain node environment
//   unit-dom:  apps/desktop component/unit tests under jsdom
// Tests are colocated as *.test.ts(x) or live under <workspace>/tests/unit/.
// The RLS isolation suite is deliberately NOT a project here — it runs through
// `node tests/rls/run-rls.mjs` (Stop hook / `pnpm test:rls`) against a real Postgres.
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
    ],
  },
})
