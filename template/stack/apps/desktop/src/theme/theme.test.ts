import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The env has no real Web Storage, so install an in-memory Storage per test and
// import theme.ts fresh (its module-scope preference is read at load time).
function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => {
      map.clear()
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', makeStorage())
  delete document.documentElement.dataset['theme']
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme', () => {
  it('nextPreference walks system → light → dark → system', async () => {
    const { nextPreference } = await import('./theme')
    expect(nextPreference('system')).toBe('light')
    expect(nextPreference('light')).toBe('dark')
    expect(nextPreference('dark')).toBe('system')
  })

  it('setThemePreference persists to localStorage and stamps [data-theme]', async () => {
    const { setThemePreference } = await import('./theme')
    setThemePreference('light')
    expect(localStorage.getItem('theme')).toBe('light')
    expect(document.documentElement.dataset['theme']).toBe('light')
    setThemePreference('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })

  it('resolves system to dark when the OS does not prefer light (no matchMedia)', async () => {
    const { setThemePreference } = await import('./theme')
    setThemePreference('system')
    // Resolution is observable through the applied [data-theme].
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })

  it('initTheme resolves + applies the persisted preference before paint', async () => {
    localStorage.setItem('theme', 'light')
    const { initTheme } = await import('./theme')
    initTheme()
    expect(document.documentElement.dataset['theme']).toBe('light')
  })

  it('while preference is system, an OS theme flip repaints live', async () => {
    let matches = false
    const listeners = new Set<() => void>()
    const mql = {
      get matches() {
        return matches
      },
      media: '(prefers-color-scheme: light)',
      addEventListener: (_type: string, callback: () => void) => {
        listeners.add(callback)
      },
      removeEventListener: (_type: string, callback: () => void) => {
        listeners.delete(callback)
      },
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mql),
    )
    const { initTheme } = await import('./theme')
    initTheme() // preference = system (empty storage)
    expect(document.documentElement.dataset['theme']).toBe('dark')
    matches = true // OS switches to light
    for (const callback of listeners) callback()
    expect(document.documentElement.dataset['theme']).toBe('light')
  })
})
