import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { en } from '../../i18n/catalog'
import { type SubmitOutcome, useCreateNote } from './useCreateNote'

// Every reducer transition is driven through the PUBLIC api (submit), never a
// test-only export: start (optimistic insert at the head), settle (reconcile
// by temp id), fail (rollback removes ONLY the temp row), reject (inline field
// error, nothing inserted). fetch settlement is test-controlled, so the
// pending window is asserted deterministically — no timers, no races.

// Full NoteDto bodies — the hook Zod-parses every 201, so stubs must honor the
// @app/schema contract exactly.
const SERVER_NOTE = {
  id: '00000000-0000-4000-8000-000000000099',
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: 'Hello',
  body: '',
  createdAt: '2026-01-01T00:00:01.000Z',
  embedding: null,
  sourceConfidence: null,
  sourceModel: null,
}
const SECOND_NOTE = {
  ...SERVER_NOTE,
  id: '00000000-0000-4000-8000-000000000100',
  title: 'Second',
  createdAt: '2026-01-01T00:00:02.000Z',
}

function jsonResponse(body: unknown, status = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** A fetch stub whose settlement the test controls — the held-POST window. */
function deferredFetch() {
  let resolve!: (response: Response) => void
  let reject!: (cause: unknown) => void
  const gate = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  const fetchMock = vi.fn(() => gate)
  return { fetchMock, promise: gate, resolve, reject }
}

describe('useCreateNote', () => {
  it('optimistically inserts a pending row while the POST is held, then reconciles on 201', async () => {
    const held = deferredFetch()
    vi.stubGlobal('fetch', held.fetchMock)
    const onFailure = vi.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    let outcome: Promise<SubmitOutcome> | undefined
    act(() => {
      outcome = result.current.submit({ title: 'Hello' })
    })

    // BEFORE fulfillment: the temp row is in the state, marked pending.
    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.rows).toHaveLength(1)
    expect(result.current.state.rows[0]?.pending).toBe(true)
    expect(result.current.state.rows[0]?.title).toBe('Hello')
    const tempId = result.current.state.rows[0]?.id

    held.resolve(jsonResponse(SERVER_NOTE))
    await act(async () => {
      await expect(outcome).resolves.toBe('settled')
    })

    // Reconciled: the SERVER row replaced the temp row (matched by temp id).
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.rows).toEqual([
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
    expect(result.current.state.rows[0]?.id).not.toBe(tempId)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('a second create inserts at the head and reconciles only its own temp row', async () => {
    const held = deferredFetch()
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(Promise.resolve(jsonResponse(SERVER_NOTE)))
      .mockReturnValueOnce(held.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useCreateNote(vi.fn()))

    await act(async () => {
      await expect(result.current.submit({ title: 'Hello' })).resolves.toBe('settled')
    })

    let outcome: Promise<SubmitOutcome> | undefined
    act(() => {
      outcome = result.current.submit({ title: 'Second' })
    })
    // Newest first: the pending temp row sits AHEAD of the reconciled row.
    expect(result.current.state.rows.map((row) => row.pending)).toEqual([true, false])
    expect(result.current.state.rows[1]).toEqual({
      createdAt: SERVER_NOTE.createdAt,
      id: SERVER_NOTE.id,
      title: 'Hello',
      pending: false,
    })

    held.resolve(jsonResponse(SECOND_NOTE))
    await act(async () => {
      await expect(outcome).resolves.toBe('settled')
    })
    expect(result.current.state.rows).toEqual([
      { id: SECOND_NOTE.id, title: 'Second', pending: false, createdAt: SECOND_NOTE.createdAt },
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
  })

  it('rolls ONLY the temp row back on a 500 and surfaces TRANSLATED copy, not the raw message', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(Promise.resolve(jsonResponse(SERVER_NOTE)))
      .mockReturnValueOnce(
        Promise.resolve(
          jsonResponse({ error: { code: 'internal', message: 'note storage exploded' } }, 500),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onFailure = vi.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: 'Hello' })).resolves.toBe('settled')
    })
    await act(async () => {
      await expect(result.current.submit({ title: 'Doomed' })).resolves.toBe('failed')
    })

    // Rollback removed the temp row and ONLY the temp row — never a phantom.
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.rows).toEqual([
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
    // The toast says what the envelope's `code` means, in the user's language. The server's own
    // English message ("note storage exploded") is a diagnostic for the logs and must NOT be the
    // sentence a user is asked to read — which is exactly what it used to be.
    const toasted: string = onFailure.mock.calls[0]?.[0] as string
    expect(toasted).toContain(en['error.api.internal'])
    expect(toasted).not.toContain('note storage exploded')
  })

  it('rolls back on a network failure with translated copy (no envelope exists to quote)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    )
    const onFailure = vi.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: 'Unlucky' })).resolves.toBe('failed')
    })

    expect(result.current.state.rows).toEqual([])
    // No envelope, so no code: the client says the one true thing it knows.
    expect(onFailure).toHaveBeenCalledWith(en['error.api.offline'])
  })

  it('rejects an invalid title at the contract boundary — no fetch, no row', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onFailure = vi.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: '' })).resolves.toBe('rejected')
    })

    expect(result.current.state.fieldError).not.toBeNull()
    expect(result.current.state.rows).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('a corrected retry clears the field error as the optimistic insert starts', async () => {
    const held = deferredFetch()
    vi.stubGlobal('fetch', held.fetchMock)
    const { result } = renderHook(() => useCreateNote(vi.fn()))

    await act(async () => {
      await result.current.submit({ title: '' })
    })
    expect(result.current.state.fieldError).not.toBeNull()

    act(() => {
      void result.current.submit({ title: 'Fixed' })
    })
    expect(result.current.state.fieldError).toBeNull()
    expect(result.current.state.status).toBe('pending')
  })

  it('is single-flight: a second submit while one is pending is rejected', async () => {
    const held = deferredFetch()
    vi.stubGlobal('fetch', held.fetchMock)
    const { result } = renderHook(() => useCreateNote(vi.fn()))

    let first: Promise<SubmitOutcome> | undefined
    act(() => {
      first = result.current.submit({ title: 'One' })
    })
    await act(async () => {
      await expect(result.current.submit({ title: 'Two' })).resolves.toBe('rejected')
    })
    expect(held.fetchMock).toHaveBeenCalledTimes(1)

    held.resolve(jsonResponse({ ...SERVER_NOTE, title: 'One' }))
    await act(async () => {
      await expect(first).resolves.toBe('settled')
    })
  })
})
