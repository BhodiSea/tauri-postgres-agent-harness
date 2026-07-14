import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAccessToken } from './host-token'

// The credential seam, both arms of it. hostAccessToken is the ONE place the webview asks
// the host for a bearer token, and it is wired into api-client at startup (main.tsx), so
// each arm decides whether every request in the app is authenticated, refused, or bare:
//
//   OUTSIDE Tauri there is no host to ask. Asking anyway throws (there is no IPC bridge in
//   a browser tab or under jsdom), so the guard must SHORT-CIRCUIT — not merely tolerate a
//   failure — and report unauthenticated.
//   INSIDE Tauri the host's answer is the whole answer, `null` included: a null means
//   "not signed in", and inventing anything else here would put a bare `Bearer` on the wire.
//
// The IPC bridge itself is mocked (apps/desktop may not import @tauri-apps/* outside
// src/ipc/ — lint-enforced); the real bridge is proven by the host crate's specta export
// test and by the mock-IPC e2e lane, not by jsdom.
const ipc = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  accessToken: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
}))

vi.mock('../ipc', () => ({
  isTauri: ipc.isTauri,
  commands: { accessToken: ipc.accessToken },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('hostAccessToken', () => {
  it('outside the Tauri host: reports unauthenticated and never asks a host that is not there', async () => {
    ipc.isTauri.mockReturnValue(false)
    // Deliberately primed with a token: if the guard ever stopped short-circuiting, the
    // only visible symptom would be this value leaking through — so assert it does NOT.
    ipc.accessToken.mockResolvedValue('token-from-a-host-that-does-not-exist')

    await expect(hostAccessToken()).resolves.toBeNull()
    expect(
      ipc.accessToken,
      'there is no IPC bridge outside Tauri — asking for the token would throw',
    ).not.toHaveBeenCalled()
  })

  it('inside the Tauri host: returns exactly the token the host holds', async () => {
    ipc.isTauri.mockReturnValue(true)
    ipc.accessToken.mockResolvedValue('host-token-abc')

    await expect(hostAccessToken()).resolves.toBe('host-token-abc')
    expect(ipc.accessToken).toHaveBeenCalledTimes(1)
  })

  it('inside the Tauri host, signed out: propagates the null instead of inventing a token', async () => {
    // The host answering `None` is the signed-out state, and it must reach api-client as
    // null — which refuses the request. A fabricated token here would send `Bearer <junk>`
    // and the 401 would read as a server fault.
    ipc.isTauri.mockReturnValue(true)
    ipc.accessToken.mockResolvedValue(null)

    await expect(hostAccessToken()).resolves.toBeNull()
    expect(
      ipc.accessToken,
      'inside the host the answer must come FROM the host, not from a local shortcut',
    ).toHaveBeenCalledTimes(1)
  })
})
