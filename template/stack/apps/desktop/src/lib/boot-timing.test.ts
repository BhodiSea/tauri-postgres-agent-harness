import { afterEach, describe, expect, it, vi } from 'vitest'

// `stampBootTiming` joins the only two halves of cold start that exist — the host's process
// clock and the webview's "interactive" — and parks the result where the real-binary lane can
// read it. Every branch here is load-bearing for that lane: a stamp that silently does not
// happen, or one that reports a fabricated 0, would leave cold start UNMEASURED while the
// nightly budget kept passing. This file lives under apps/desktop/src/lib/, which is in the
// mutation-critical set — the ratchet will change this code and demand a test go red.

const bootElapsedMs = vi.fn<() => Promise<number>>()
const isTauri = vi.fn<() => boolean>()

vi.mock('../ipc', () => ({
  isTauri: () => isTauri(),
  commands: { bootElapsedMs: () => bootElapsedMs() },
}))

const { stampBootTiming } = await import('./boot-timing')

afterEach(() => {
  vi.clearAllMocks()
  delete document.documentElement.dataset['bootMs']
})

describe('stampBootTiming', () => {
  it('publishes the host-reported boot time onto <html data-boot-ms>', async () => {
    isTauri.mockReturnValue(true)
    bootElapsedMs.mockResolvedValue(1234)

    await stampBootTiming()

    expect(document.documentElement.dataset['bootMs']).toBe('1234')
  })

  it('asks the HOST for the number rather than timing anything webview-side', async () => {
    isTauri.mockReturnValue(true)
    bootElapsedMs.mockResolvedValue(42)

    await stampBootTiming()

    // The webview cannot see when the process started; only the host can. If this call ever
    // disappears, the attribute would carry a number measured from the wrong origin.
    expect(bootElapsedMs).toHaveBeenCalledTimes(1)
  })

  it('does nothing outside Tauri — a browser tab has no host boot to report', async () => {
    isTauri.mockReturnValue(false)

    await stampBootTiming()

    expect(bootElapsedMs).not.toHaveBeenCalled()
    expect(document.documentElement.dataset['bootMs']).toBeUndefined()
  })

  it('leaves the attribute ABSENT when the host fails, rather than stamping a fake 0', async () => {
    isTauri.mockReturnValue(true)
    bootElapsedMs.mockRejectedValue(new Error('ipc down'))

    // Telemetry must never take the app down with it.
    await expect(stampBootTiming()).resolves.toBeUndefined()

    // The cold-start spec fails on an ABSENT attribute. That is the correct outcome: the
    // measurement did not happen, and a fabricated value would let the budget pass on a lie.
    expect(document.documentElement.dataset['bootMs']).toBeUndefined()
  })
})
