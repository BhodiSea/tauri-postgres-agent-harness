// unit-dom setup (wired in vitest.config.ts). Two determinism rules:
//
// 1. Unit tests never touch the network. The connection probe's fetch gets a
//    pending-forever stub, so the 'connecting' state is assertable without a
//    race and no late rejection can schedule React work after jsdom teardown
//    ("window is not defined"). Real probe outcomes (ok/degraded) are e2e
//    territory, driven via page.route.
// 2. Unmount everything after every test. Without vitest globals, testing-library
//    does not auto-register its cleanup, and an App left mounted keeps its probe
//    interval alive across tests.
// SOURCE: docs/harness/README.md (determinism doctrine) [corpus: harness/doctrine]
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))

afterEach(() => {
  cleanup()
})
