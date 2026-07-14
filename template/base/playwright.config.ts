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
declare const process:
  | {
      env: {
        CI?: string
        HARNESS_PERF_LANE?: string
        HARNESS_INTEGRATION_LANE?: string
        VITE_API_ORIGIN?: string
      }
    }
  | undefined

const inCI = process?.env.CI !== undefined

// The CI-only interaction-latency lane (e2e/interaction-latency.spec.ts): the
// 'perf' project EXISTS only under HARNESS_PERF_LANE=1, and the default
// chromium project testIgnores its spec — so the agent-time e2e gate
// (tools/check-e2e.mjs, which additionally strips the env var) and the CI
// e2e-fast job run exactly the same non-perf suite as before this lane existed.
// Wall-clock browser timing is the flakiest surface in the repo; it must never
// enter the deterministic validate chain or the warm ≈5s Stop-hook path.
const perfLane = process?.env.HARNESS_PERF_LANE === '1'
// Two specs share the perf lane: interaction-latency (wall-clock UX budgets) and memory
// (the leak ceiling — mount/unmount every route N times and diff the live CDP counters
// after a forced GC). Both are browser-driven and shared-runner-noisy, and neither may
// ever enter the validate chain.
const PERF_SPEC = /(?:interaction-latency|memory)\.spec\.ts$/

// The CI-only INTEGRATION lane (e2e/integration.spec.ts): the one place the two halves
// of the app meet for real. Every other spec in this file mocks the network with
// page.route — which is exactly how the desktop shipped for five releases sending no
// Authorization header at all and still passing every gate. This lane stubs NOTHING but
// the Tauri IPC (which supplies the host-held token): a real vite bundle, a real fetch,
// a real Hono server in stub-auth mode, real Postgres under FORCE RLS. It needs those
// services, so like the perf lane it exists only under its env flag and runs as a
// blocking CI job — never in the agent-time chain.
const integrationLane = process?.env.HARNESS_INTEGRATION_LANE === '1'
const INTEGRATION_SPEC = /integration\.spec\.ts$/

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
    // Determinism: freeze `motion-safe:` animations. Axe blends ANIMATED opacity
    // into its color-contrast math, so a pulsing skeleton reads a different
    // contrast ratio depending on when the snapshot lands — pass or fail by
    // timing. Under reduced motion axe measures the true resting contrast.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      testIgnore: [PERF_SPEC, INTEGRATION_SPEC],
    },
    ...(integrationLane
      ? [
          {
            name: 'integration',
            testMatch: INTEGRATION_SPEC,
            // One worker: the specs create rows in a shared database and assert on
            // list contents. Parallel writers would see each other's notes.
            fullyParallel: false,
            use: { browserName: 'chromium' },
          },
        ]
      : []),
    ...(perfLane
      ? [
          {
            name: 'perf',
            testMatch: PERF_SPEC,
            // Wall-clock samples never share a CPU: the three perf tests run
            // serially in one worker (the CI job adds --workers 1 as belt and
            // braces). reducedMotion:'reduce' is INHERITED deliberately: it
            // freezes decorative motion-safe animations (less rAF/paint noise,
            // fewer flakes) while the scripted work this lane times — keydown
            // handlers, mount, data processing — is unaffected by the media
            // query; animation cost is bounded separately by the motion-opt-in
            // doctrine (e2e/motion.spec.ts).
            fullyParallel: false,
            use: { browserName: 'chromium' },
          },
        ]
      : []),
  ],
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
      // The integration lane is the exception: a REAL server listens, and the CI job
      // passes its origin through, so the bundle talks to it instead of a stub.
      // `||`, not `??`: an exported-but-EMPTY VITE_API_ORIGIN survives `??` and would be
      // forwarded to Vite as '', turning every request into a same-origin relative path.
      VITE_API_ORIGIN: process?.env.VITE_API_ORIGIN || 'http://127.0.0.1:8787',
    },
  },
})
