import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { ROUTES } from '../../routes'
import { NotesPanel } from './NotesPanel'

// The optimistic write path through the REAL panel: composer submit → temp row
// at the list head (pending affordance) → reconcile on 201 / rollback + toast
// on failure. The read-path states (loading/empty/error) stay covered by
// App.test.tsx against the src/routes.ts manifest; e2e/mutation.spec.ts drives
// the same write flow browser-side with held route fulfillments.

const [HOME] = ROUTES

// Full NoteDto rows — the panel Zod-parses every wire body.
const EXISTING = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: 'First note',
  body: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  embedding: null,
  sourceConfidence: null,
  sourceModel: null,
}
const SERVER_NOTE = {
  ...EXISTING,
  id: '00000000-0000-4000-8000-000000000099',
  title: 'Fresh note',
  createdAt: '2026-01-01T00:00:01.000Z',
}

const page = (items: readonly unknown[]) => ({ items, nextCursor: null })

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// Route by URL + method: GETs to /api/notes serve the list, POSTs the create;
// everything else (the /healthz probe) stays pending — same rule as App.test.
function stubNetwork(options: {
  readonly list: () => Promise<Response>
  readonly create?: () => Promise<Response>
}) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (!url.endsWith('/api/notes')) return new Promise<Response>(() => undefined)
    if (init?.method === 'POST') {
      return options.create === undefined
        ? new Promise<Response>(() => undefined)
        : options.create()
    }
    return options.list()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPanel() {
  return render(
    <ToastProvider>
      <NotesPanel />
    </ToastProvider>,
  )
}

afterEach(() => {
  // Back to the test-setup baseline (never unstubAllGlobals — that would
  // restore the REAL network-touching fetch for the rest of the file).
  vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))
})

describe('NotesPanel optimistic create', () => {
  it('holds a pending row at the list head while the POST is in flight, then reconciles', async () => {
    let releaseCreate!: (response: Response) => void
    const held = new Promise<Response>((resolve) => {
      releaseCreate = resolve
    })
    stubNetwork({ list: () => Promise.resolve(jsonResponse(page([EXISTING]))), create: () => held })
    renderPanel()
    await screen.findByText('First note')

    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Fresh note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    // BEFORE fulfillment: pending row first, pending affordance on the button.
    const pendingRow = (await screen.findByText('Fresh note')).closest('li')
    expect(pendingRow?.getAttribute('data-pending')).toBe('true')
    const list = screen.getByRole('list')
    expect(list.firstElementChild?.textContent).toBe('Fresh note')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Adding…' }).disabled).toBe(true)

    releaseCreate(jsonResponse(SERVER_NOTE, 201))

    // Reconciled: pending marker gone, the SERVER id is on the row, draft cleared.
    await waitFor(() => {
      const row = screen.getByText('Fresh note').closest('li')
      expect(row?.getAttribute('data-pending')).toBeNull()
      expect(row?.getAttribute('data-note-id')).toBe(SERVER_NOTE.id)
    })
    expect(screen.getByLabelText<HTMLInputElement>('Add a note').value).toBe('')
    expect(screen.getByText('First note')).toBeDefined() // the fetched page is intact
  })

  it('rolls the row back on a 500 envelope and toasts the envelope message', async () => {
    stubNetwork({
      list: () => Promise.resolve(jsonResponse(page([EXISTING]))),
      create: () =>
        Promise.resolve(
          jsonResponse({ error: { code: 'internal', message: 'note storage exploded' } }, 500),
        ),
    })
    renderPanel()
    await screen.findByText('First note')

    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Doomed note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    // The envelope's human message surfaces through the toast live region…
    expect(await screen.findByText('note storage exploded')).toBeDefined()
    // …and the temp row is GONE (rollback), while the draft survives for retry.
    expect(screen.queryByText('Doomed note')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('Add a note').value).toBe('Doomed note')
  })

  it('a first optimistic note replaces the empty state with the list', async () => {
    stubNetwork({ list: () => Promise.resolve(jsonResponse(page([]))) }) // POST held forever
    renderPanel()
    await screen.findByTestId(HOME.states.empty)

    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Fresh note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    const row = (await screen.findByText('Fresh note')).closest('li')
    expect(row?.getAttribute('data-pending')).toBe('true')
    expect(screen.queryByTestId(HOME.states.empty)).toBeNull()
  })

  it('an invalid title renders the contract message inline and never POSTs', async () => {
    const fetchMock = stubNetwork({ list: () => Promise.resolve(jsonResponse(page([]))) })
    renderPanel()
    await screen.findByTestId(HOME.states.empty)

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    const input = screen.getByLabelText('Add a note')
    await waitFor(() => {
      expect(input.getAttribute('aria-invalid')).toBe('true')
    })
    const describedBy = input.getAttribute('aria-describedby') ?? ''
    expect(describedBy).not.toBe('')
    expect(document.getElementById(describedBy)?.textContent).not.toBe('')
    // Zod rejected at the boundary — no POST ever left the app.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
})
