import type { Page } from '@playwright/test'

// Test doubles for the fast e2e lane: the app runs in plain chromium (vite dev),
// so the two host boundaries are stubbed here —
//   1. installMockIpc: a window.__TAURI_INTERNALS__/invoke mock, installed BEFORE
//      any app code runs, so `isTauri()` reports true and the typed IPC facade
//      (src/ipc/) resolves without a Rust host.
//   2. stubHealthz: page.route interception of the ConnectionStatus /healthz probe
//      (ok / HTTP error / connection refused). Fulfilled cross-origin responses
//      still pass the browser's CORS check, hence the explicit allow-origin header.
// Real-binary IPC + WebDriver coverage lives in the opt-in ci-windows-e2e module.

export interface MockIpcOptions {
  /** Version string the mocked `app_version` command reports. */
  readonly appVersion?: string
  /**
   * Pin `localStorage.theme='dark'` before load (default true) so the
   * theme-agnostic specs (a11y/states/degraded) render against one stable theme.
   * e2e/theme.spec.ts passes `false` to own the stored preference itself — and so
   * a toggled choice can survive a reload without the init script re-pinning it.
   */
  readonly pinTheme?: boolean
}

interface TauriInternalsMock {
  invoke: (cmd: string) => Promise<unknown>
  transformCallback: (callback?: (response: unknown) => void, once?: boolean) => number
  metadata: {
    currentWindow: { label: string }
    currentWebview: { label: string }
  }
}

export async function installMockIpc(page: Page, options: MockIpcOptions = {}): Promise<void> {
  const appVersion = options.appVersion ?? '0.1.0-e2e'
  const pinTheme = options.pinTheme ?? true
  await page.addInitScript(
    ({ version, pinTheme: pin }) => {
      // Pin the theme so the theme-agnostic specs (a11y/states/degraded) are
      // deterministic: chromium defaults prefers-color-scheme to light, which
      // would otherwise flip the `system` default and change computed contrast.
      // theme.spec opts out (pinTheme:false) and drives light/dark explicitly.
      if (pin) {
        try {
          localStorage.setItem('theme', 'dark')
        } catch {
          // Storage unavailable in some contexts — the app falls back to system.
        }
      }
      let nextCallbackId = 0
      const internals: TauriInternalsMock = {
        // Commands the scaffold shell uses; everything else (plugin:event|listen
        // from attachConsole, plugin:log forwarding, …) resolves to a benign id.
        invoke: (cmd: string): Promise<unknown> => {
          if (cmd === 'app_version') return Promise.resolve(version)
          nextCallbackId += 1
          return Promise.resolve(nextCallbackId)
        },
        transformCallback: (): number => {
          nextCallbackId += 1
          return nextCallbackId
        },
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
      }
      Object.defineProperty(window, 'isTauri', { value: true, configurable: true })
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: internals,
        configurable: true,
      })
    },
    { version: appVersion, pinTheme },
  )
}

/**
 * Override the stored theme preference before the app loads. Runs as an
 * addInitScript, so it lands ahead of theme.ts's initTheme on every navigation
 * AND after installMockIpc's own script — hence it wins over the pinned-dark
 * default. Pass `null` to clear the key (falls back to the `system` preference).
 */
export async function setStoredTheme(
  page: Page,
  preference: 'light' | 'dark' | 'system' | null,
): Promise<void> {
  await page.addInitScript((value) => {
    try {
      if (value === null) localStorage.removeItem('theme')
      else localStorage.setItem('theme', value)
    } catch {
      // Storage unavailable in some contexts — the app falls back to system.
    }
  }, preference)
}

export type HealthzStub =
  | { readonly kind: 'ok'; readonly version?: string }
  | { readonly kind: 'http-error'; readonly status?: number }
  | { readonly kind: 'offline' }

const CORS_HEADERS = { 'access-control-allow-origin': '*' } as const

export async function stubHealthz(page: Page, stub: HealthzStub): Promise<void> {
  await page.route('**/healthz', async (route) => {
    if (stub.kind === 'offline') {
      await route.abort('connectionrefused')
      return
    }
    if (stub.kind === 'http-error') {
      await route.fulfill({
        status: stub.status ?? 500,
        headers: CORS_HEADERS,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, version: stub.version ?? '0.1.0-e2e' }),
    })
  })
}

// A full NoteDto wire row — the @app/schema contract NotesPanel/useKeysetQuery
// Zod-parse, so every field must be present and well-typed. The id/title are
// derived from the index so rows stay unique and stable across runs and pages.
interface NoteRow {
  readonly id: string
  readonly ownerId: string
  readonly title: string
  readonly body: string
  readonly createdAt: string
  readonly embedding: null
  readonly sourceConfidence: number | null
  readonly sourceModel: string | null
}

function noteRow(index: number, title: string): NoteRow {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title,
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: null,
    sourceModel: null,
  }
}

/**
 * `count` sequential NoteDto rows starting at `offset` — unique ids + titles, for
 * the theme sweep's ready content and the matrix's multi-page keyset stubs. Stays
 * under NOTES_PAGE_LIMIT_MAX (200) per page so NotesPage.parse accepts it.
 */
export function makeNoteRows(count: number, offset = 0): readonly NoteRow[] {
  return Array.from({ length: count }, (_, i) =>
    noteRow(offset + i, `Note ${String(offset + i + 1)}`),
  )
}

// Data stub for the home screen's notes panel (the ready state): a NotesPage
// body of full NoteDto rows built from the given titles. The loading / empty /
// error behavior classes are driven in e2e/states.spec.ts.
export async function stubNotes(page: Page, titles: readonly string[]): Promise<void> {
  const items = titles.map((title, index) => noteRow(index, title))
  await page.route('**/api/notes', async (route) => {
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify({ items, nextCursor: null }),
    })
  })
}

// The fast lane's stub API origin is port 8787 (playwright.config webServer env).
// Every request there except the /healthz probe is a data request owned by the
// spec stubs — matched by PREDICATE, not a `**/api/notes` glob, so query strings
// (?limit=, ?cursor=) are covered too. Same rule states.spec.ts applies inline.
const isDataRequest = (url: URL): boolean =>
  url.port === '8787' && !url.pathname.endsWith('/healthz')

/**
 * Answer every data request with one fixed JSON body (a ready NotesPage, an empty
 * page, …). theme.spec sweeps each route's ready surface with this; the body is
 * serialized here so callers pass a plain object.
 */
export async function stubDataRequests(page: Page, body: unknown): Promise<void> {
  await page.route(isDataRequest, async (route) => {
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

/**
 * Route every data request through an un-resolved gate: the screen sits in its
 * loading state until the returned `release` is called (or the context closes).
 * motion.spec holds the notes response so the Skeleton pulse is on-screen while
 * it asserts prefers-reduced-motion actually stopped it.
 */
export async function holdDataRequests(page: Page): Promise<() => void> {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(isDataRequest, async (route) => {
    await gate
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: '{"items":[],"nextCursor":null}',
    })
  })
  return release
}

/**
 * Resolve once no animation OR transition is still running. A theme change fires
 * colour transitions (collapsed to ~instant under reduced motion); axe reads
 * getComputedStyle, so sweeping before they settle can catch a mid-transition
 * contrast frame. Polled per animation frame — no fixed wait.
 */
export async function waitForMotionSettled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  )
}

interface NotesPageStub {
  readonly items: readonly NoteRow[]
  readonly nextCursor: string | null
}

/**
 * Cursor-aware keyset stub: the first request (no `cursor=`) is answered with
 * pages[0]; any request carrying a cursor gets pages[1]. matrix.spec uses this to
 * prove Load-more forwards the previous page's nextCursor in the request URL.
 */
export async function stubNotesPages(page: Page, pages: readonly NotesPageStub[]): Promise<void> {
  await page.route(isDataRequest, async (route) => {
    const requested = new URL(route.request().url())
    const hasCursor = requested.searchParams.get('cursor') !== null
    const body = (hasCursor ? pages[1] : pages[0]) ?? { items: [], nextCursor: null }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}
