// unit-dom setup (wired in vitest.config.ts). Three determinism rules:
//
// 1. Unit tests never touch the network. The connection probe's fetch gets a
//    pending-forever stub, so the 'connecting' state is assertable without a
//    race and no late rejection can schedule React work after jsdom teardown
//    ("window is not defined"). Real probe outcomes (ok/degraded) are e2e
//    territory, driven via page.route.
// 2. Unmount everything after every test. Without vitest globals, testing-library
//    does not auto-register its cleanup, and an App left mounted keeps its probe
//    interval alive across tests.
// 3. Every test runs SIGNED IN. The api-client asks the Tauri host for a bearer
//    token and refuses to send without one; there is no host under jsdom, so
//    without this the whole suite would exercise the signed-out path and the
//    authenticated one would go untested. A test that wants the signed-out surface
//    calls setAccessTokenProvider itself.
// SOURCE: docs/harness/README.md (determinism doctrine) [corpus: harness/doctrine]
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { setAccessTokenProvider } from './lib/api-client'

vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))

// Re-installed before EVERY test, so a test that swaps the provider (api-client.test.ts
// drives the signed-out path) cannot leak that choice into the next one.
beforeEach(() => {
  setAccessTokenProvider(() => Promise.resolve('unit-test-token'))
})

afterEach(() => {
  cleanup()
})
