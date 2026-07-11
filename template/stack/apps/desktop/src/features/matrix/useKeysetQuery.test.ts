import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeysetQuery } from './useKeysetQuery'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response
}

function note(id: string) {
  return {
    // NoteDto validates id/ownerId as UUIDs — build valid ones from the label.
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title: `note ${id}`,
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: null,
    sourceModel: null,
  }
}

function page(ids: readonly string[], nextCursor: string | null) {
  return { items: ids.map(note), nextCursor }
}

const noop = (): void => undefined

afterEach(() => {
  // Restore the test-setup baseline (a pending-forever fetch).
  vi.stubGlobal('fetch', () => new Promise<never>(() => undefined))
})

describe('useKeysetQuery', () => {
  it('loads the first page into the ready state with rows and a cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(page(['1', '2'], 'c2')))),
    )
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    expect(result.current.state.rows.length).toBe(2)
    expect(result.current.state.cursor).toBe('c2')
  })

  it('an empty first page is the empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(page([], null)))),
    )
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('empty')
    })
  })

  it('an initial-load failure owns the route error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: {} }, false, 500))),
    )
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
    expect(result.current.state.message).toContain('500')
  })

  it('loadMore appends the next page and forwards the cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page(['1'], 'c2')))
      .mockResolvedValueOnce(jsonResponse(page(['2'], null)))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    act(() => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.state.rows.length).toBe(2)
    })
    expect(result.current.state.cursor).toBeNull()
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=c2')
  })

  it('a loadMore failure raises the callback + inline retry flag, data intact', async () => {
    const onError = vi.fn()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page(['1'], 'c2')))
      .mockResolvedValueOnce(jsonResponse({ error: {} }, false, 503))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useKeysetQuery(onError))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    act(() => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.state.loadMoreFailed).toBe(true)
    })
    expect(onError).toHaveBeenCalledOnce()
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state.rows.length).toBe(1)
  })

  it('reload aborts a slow initial load so a stale response cannot overwrite newer state', async () => {
    let resolveFirst: (response: Response) => void = () => undefined
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(jsonResponse(page([], null)))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useKeysetQuery(noop))
    expect(result.current.state.status).toBe('loading')
    act(() => {
      result.current.reload()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('empty')
    })
    act(() => {
      resolveFirst(jsonResponse(page(['stale'], 'x')))
    })
    await Promise.resolve()
    expect(result.current.state.status).toBe('empty')
  })
})
