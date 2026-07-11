import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HomeScreen } from './HomeScreen'

// Both host modes are unit territory: outside the Tauri host the IPC bridge is
// absent by design (plain-browser vite dev, jsdom), inside it the version probe
// resolves over typed bindings. The bridge itself is mocked — the real IPC
// surface is exercised by the host crate's specta export test, not jsdom.
const ipc = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  appVersion: vi.fn<() => Promise<string>>(() => Promise.resolve('9.9.9')),
}))

vi.mock('../ipc', () => ({
  isTauri: ipc.isTauri,
  commands: { appVersion: ipc.appVersion },
}))

describe('HomeScreen', () => {
  it('outside the Tauri host: renders the welcome card and never calls the IPC bridge', () => {
    ipc.isTauri.mockReturnValue(false)
    render(<HomeScreen />)
    expect(screen.getByRole('heading', { level: 2, name: 'Ready to build' })).toBeDefined()
    expect(screen.getByText('Running outside the Tauri host')).toBeDefined()
    expect(ipc.appVersion).not.toHaveBeenCalled()
  })

  it('inside the Tauri host: probes and renders the host version', async () => {
    ipc.isTauri.mockReturnValue(true)
    render(<HomeScreen />)
    expect(await screen.findByText('Tauri host v9.9.9')).toBeDefined()
  })
})
