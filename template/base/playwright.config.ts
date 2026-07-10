import { defineConfig } from '@playwright/test'

// Root Playwright config — the FAST e2e lane: plain-browser chromium against
// `vite dev`, no Tauri binary. The Tauri IPC bridge is mocked per spec
// (e2e/mock-ipc.ts) and the API is stubbed via page.route, so this lane runs
// anywhere chromium does — locally and in the quality-gate e2e-fast job.
// Real-binary E2E on Windows lives in the opt-in ci-windows-e2e module.
//
// Config files at the repo root belong to no tsconfig project; ESLint checks
// them via the projectService default project (same as vitest.config.ts), so
// node globals are declared locally instead of pulling in @types/node.
declare const process: { env: { CI?: string } } | undefined

const inCI = process?.env.CI !== undefined

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: inCI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Same fixed dev port contract as tauri.conf.json devUrl (1420, strict).
    command: 'pnpm --filter desktop exec vite dev --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: !inCI,
    timeout: 120_000,
    env: {
      // Stub origin: nothing listens here BY DESIGN — every spec intercepts
      // ${VITE_API_ORIGIN}/healthz with page.route (see e2e/mock-ipc.ts), so the
      // lane needs no running server and un-stubbed requests fail loudly.
      VITE_API_ORIGIN: 'http://127.0.0.1:8787',
    },
  },
})
