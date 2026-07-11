import { useSyncExternalStore } from 'react'

// Light/dark theming. `dark` is the design base (the @theme block in styles.css)
// and the launch frame; `light` is a full token override keyed off
// document.documentElement[data-theme]. The user's explicit choice is persisted;
// `system` defers to the OS and tracks it live.
// SOURCE: prefers-color-scheme is the read-only system signal — persisting an
// explicit override layered over it is the app's own responsibility
// [corpus: web/prefers-color-scheme]
export type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

// Query the LIGHT preference (not dark): jsdom's matchMedia stub reports
// matches=false, so the resolved default stays `dark` and the existing unit
// tests render against the base theme unchanged.
// SOURCE: prefers-color-scheme media feature [corpus: web/prefers-color-scheme]
const LIGHT_QUERY = '(prefers-color-scheme: light)'

// Captured once, guarded: outside a browser (SSR-style import) matchMedia is
// absent, so `system` resolves to `dark` rather than throwing at import time.
// globalThis (=== window in a browser) so a test can stub it via vi.stubGlobal.
const mediaQuery: MediaQueryList | null =
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(LIGHT_QUERY) : null

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    // Private-mode / disabled storage: fall back to the system default.
    return 'system'
  }
}

function systemPrefersLight(): boolean {
  return mediaQuery?.matches ?? false
}

/** The concrete theme actually painted, collapsing `system` to light/dark. */
function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return preference
}

function applyTheme(resolved: ResolvedTheme): void {
  // dataset has an index signature (noPropertyAccessFromIndexSignature) — bracket
  // access required; sets the [data-theme] attribute styles.css keys the theme on.
  document.documentElement.dataset['theme'] = resolved
}

let preference: ThemePreference = readPreference()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

// While the preference is `system`, an OS theme flip must repaint live.
function onSystemChange(): void {
  if (preference === 'system') {
    applyTheme(resolveTheme(preference))
    emit()
  }
}

/**
 * Resolve + apply the persisted preference and start tracking the OS signal.
 * Called from main.tsx BEFORE createRoot so the correct theme is on the root
 * element before the first paint (no theme flash).
 */
export function initTheme(): void {
  preference = readPreference()
  applyTheme(resolveTheme(preference))
  mediaQuery?.addEventListener('change', onSystemChange)
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Non-persistent storage still gets the in-session switch below.
  }
  applyTheme(resolveTheme(next))
  emit()
}

// system → light → dark → system. The toggle button walks this ring.
const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export function nextPreference(current: ThemePreference): ThemePreference {
  return CYCLE[current]
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getSnapshot(): ThemePreference {
  return preference
}

interface ThemeControls {
  readonly preference: ThemePreference
  /** Advance system → light → dark → system, persisting + applying the choice. */
  readonly cycle: () => void
}

export function useTheme(): ThemeControls {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    preference: current,
    cycle: () => {
      setThemePreference(nextPreference(current))
    },
  }
}
