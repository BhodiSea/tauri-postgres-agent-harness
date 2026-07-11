import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SHORTCUTS, type Shortcut } from './keyboard/registry'
import { ROUTES } from './routes'

// Widened to the registry interface: with only global entries today, the scope
// filter below would otherwise be a vacuous always-true comparison (lint-red).
const REGISTERED: readonly Shortcut[] = SHORTCUTS

describe('App shell', () => {
  it('renders the title bar, connection status region, and shortcut hints', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '{{PROJECT_NAME}}' })).toBeDefined()
    // role=status is the aria-live region the connection probe writes into.
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('starts in the connecting state — never claims "unreachable" before the first probe resolves', () => {
    render(<App />)
    expect(screen.getByRole('status').textContent).toContain('Connecting')
  })

  // Registry-driven: every advertised global shortcut must DO something.
  // (The Record<ShortcutId, …> handler map in App.tsx already makes a missing
  // handler a compile error; this asserts the wiring end-to-end in the DOM.)
  it.each(
    REGISTERED.filter((s) => s.scope === 'global'),
  )('global shortcut $keys ($id) has a visible effect', ({ keys }) => {
    const { unmount } = render(<App />)
    const key = keys.split('+').at(-1) ?? ''
    fireEvent.keyDown(window, { key, ctrlKey: keys.includes('mod') })
    // Both registered shortcuts open a dialog surface; a future shortcut
    // with a different effect should extend this expectation, not delete it.
    const dialogs = document.querySelectorAll('dialog[open]')
    expect(dialogs.length).toBeGreaterThan(0)
    unmount()
  })

  it('mod+/ opens the shortcuts overlay listing every registry entry', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    for (const shortcut of SHORTCUTS) {
      expect(screen.getAllByText(shortcut.keys).length).toBeGreaterThan(0)
    }
  })

  it('mod+k opens the command palette; typing filters; Enter runs the active command', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('combobox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'shortcuts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Running "Show keyboard shortcuts" swaps the palette for the overlay —
    // assert the OVERLAY dialog itself, not the footer hint text.
    const overlay = [...document.querySelectorAll('dialog[open]')].find(
      (dialog) => dialog.getAttribute('aria-label') === 'Keyboard shortcuts',
    )
    expect(overlay).toBeDefined()
  })
})

describe('home screen data states (src/routes.ts manifest)', () => {
  // The scaffold's single screen; its manifest entry names the state test ids
  // asserted here AND driven browser-side by e2e/states.spec.ts.
  const [home] = ROUTES

  // A full NoteDto — NotesPanel Zod-parses the wire body, so stubs must honor
  // the @app/schema contract exactly.
  const NOTE = {
    id: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title: 'First note',
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: null,
    sourceModel: null,
  }

  const page = (items: readonly unknown[]) => ({ items, nextCursor: null })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response
  }

  // Route by URL: /api/notes gets the injected behavior; everything else (the
  // /healthz probe) stays pending — same rule as the global test-setup stub.
  function stubFetch(notes: () => Promise<Response>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString()
        return url.endsWith('/api/notes') ? notes() : new Promise<Response>(() => undefined)
      }),
    )
  }

  afterEach(() => {
    // Back to the test-setup baseline (never unstubAllGlobals — that would
    // restore the REAL network-touching fetch for the rest of the file).
    vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))
  })

  it('renders the loading state while the notes query is in flight', () => {
    stubFetch(() => new Promise<Response>(() => undefined))
    render(<App />)
    expect(screen.getByTestId(home.states.loading)).toBeDefined()
  })

  it('renders the empty state when the query resolves to zero items', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(page([]))))
    render(<App />)
    expect(await screen.findByTestId(home.states.empty)).toBeDefined()
  })

  it('renders the ready state: one list item per note title', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(page([NOTE]))))
    render(<App />)
    expect(await screen.findByText('First note')).toBeDefined()
    expect(screen.queryByTestId(home.states.loading)).toBeNull()
  })

  it('renders the error state on a 500, and its retry affordance recovers', async () => {
    let failing = true
    stubFetch(() =>
      Promise.resolve(
        failing
          ? jsonResponse({ error: { code: 'internal', message: 'boom' } }, 500)
          : jsonResponse(page([])),
      ),
    )
    render(<App />)
    const errorSurface = await screen.findByTestId(home.states.error)
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(errorSurface.contains(retry)).toBe(true)
    failing = false
    fireEvent.click(retry)
    expect(await screen.findByTestId(home.states.empty)).toBeDefined()
    expect(screen.queryByTestId(home.states.error)).toBeNull()
  })
})

describe('ErrorBoundary', () => {
  it('renders a styled, recoverable alert instead of a blank window', () => {
    function Boom(): never {
      throw new Error('render exploded')
    }
    // React logs the caught error to console.error by design; silence locally.
    const original = console.error
    console.error = () => undefined
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      )
    } finally {
      console.error = original
    }
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('render exploded')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
  })
})

describe('theme toggle', () => {
  it('cycles the theme, relabels for the next state, and toasts the switch', async () => {
    render(<App />)
    const toggle = screen.getByTestId('theme-toggle')
    const before = toggle.getAttribute('aria-label')
    expect(before).toMatch(/Switch to (light|dark|system) theme/)
    fireEvent.click(toggle)
    // The switch is confirmed via the polite toast live region.
    expect(await screen.findByText(/^Theme: (light|dark|system)$/)).toBeDefined()
    // The label now names the NEW next state (the cycle advanced).
    expect(screen.getByTestId('theme-toggle').getAttribute('aria-label')).not.toBe(before)
  })
})

describe('primary navigation (hand-rolled router + lazy matrix route)', () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
  }
  function note(id: string) {
    return {
      id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
      ownerId: '00000000-0000-4000-8000-0000000000aa',
      title: `note ${id}`,
      body: 'a b c',
      createdAt: '2026-01-01T00:00:00.000Z',
      embedding: null,
      sourceConfidence: 0.5,
      sourceModel: null,
    }
  }
  // Route every /api/notes request (with or without cursor/limit query) to one
  // page — covers both the home NotesPanel and the matrix keyset query.
  function stubNotesPages(items: readonly unknown[], nextCursor: string | null): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString()
        return url.includes('/api/notes')
          ? Promise.resolve(jsonResponse({ items, nextCursor }))
          : new Promise<Response>(() => undefined)
      }),
    )
  }

  afterEach(() => {
    vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))
    window.history.pushState(null, '', '/')
  })

  it('navigating to Matrix lazy-loads the screen and reaches its empty state', async () => {
    stubNotesPages([], null)
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Matrix' }))
    expect(await screen.findByTestId('matrix-empty')).toBeDefined()
  })

  it('matrix ready state renders the grid, the distribution summary, and Load more', async () => {
    stubNotesPages([note('1'), note('2'), note('3')], 'c2')
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Matrix' }))
    expect(await screen.findByRole('grid')).toBeDefined()
    expect(screen.getByRole('img', { name: /Distribution/ })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })
})
