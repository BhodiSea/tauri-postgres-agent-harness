import { ApiError, NewNoteInput, NoteDto } from '@app/schema'
import { useCallback, useReducer, useRef } from 'react'

// The write-UX exemplar: ONE plain reducer drives the whole optimistic
// create-note lifecycle. Submit validates against the @app/schema contract at
// the fetch boundary, inserts a temp row (pending: true) BEFORE the POST so the
// list answers instantly, then reconciles the temp row with the server row on
// 2xx or rolls it back (removes it) on failure — a single rollback path, no
// retry queue, no cache layer. Failures surface through the injected callback
// (the Toast pattern, same seam as useKeysetQuery's onLoadMoreError).
// SOURCE: harness doctrine — latency feel is a first-class UI concern; the
// optimistic row must never outlive a failed write [corpus: harness/doctrine]

// Dev override via Vite env; otherwise the API origin baked into the committed
// CSP at install time (same convention as useListQuery).
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '{{API_ORIGIN}}'

/** What the list renders for an optimistic entry — temp while pending, server after. */
export interface ComposerRow {
  readonly id: string
  readonly title: string
  readonly pending: boolean
}

export type CreateNoteStatus = 'idle' | 'pending' | 'error'

export interface CreateNoteState {
  readonly status: CreateNoteStatus
  /** Inline zod message for the title field (Field renders it) — null when valid. */
  readonly fieldError: string | null
  /** Optimistic overlay, newest first: temp rows in flight, server rows once reconciled. */
  readonly rows: readonly ComposerRow[]
}

type CreateNoteAction =
  | { readonly type: 'reject'; readonly message: string }
  | { readonly type: 'start'; readonly row: ComposerRow }
  | { readonly type: 'settle'; readonly tempId: string; readonly row: ComposerRow }
  | { readonly type: 'fail'; readonly tempId: string }

const CREATE_NOTE_INITIAL: CreateNoteState = { status: 'idle', fieldError: null, rows: [] }

// Every transition is reachable through submit(), so the hook's unit tests
// drive the whole machine via the public API — nothing test-only is exported.
function createNoteReducer(state: CreateNoteState, action: CreateNoteAction): CreateNoteState {
  switch (action.type) {
    case 'reject': // contract validation failed — nothing was inserted
      return { ...state, status: 'idle', fieldError: action.message }
    case 'start': // optimistic insert at the head (newest first, like the server order)
      return { status: 'pending', fieldError: null, rows: [action.row, ...state.rows] }
    case 'settle': // reconcile: the server row replaces the temp row in place
      return {
        status: 'idle',
        fieldError: null,
        rows: state.rows.map((row) => (row.id === action.tempId ? action.row : row)),
      }
    case 'fail': // rollback: the temp row is REMOVED — never a phantom row after a failed write
      return {
        status: 'error',
        fieldError: null,
        rows: state.rows.filter((row) => row.id !== action.tempId),
      }
  }
}

export type SubmitOutcome = 'rejected' | 'settled' | 'failed'

// Every non-2xx body is the ONE error envelope — surface its human message;
// fall back to the status when a proxy answers with something else entirely.
async function envelopeMessage(response: Response): Promise<string> {
  try {
    return ApiError.parse(await response.json()).error.message
  } catch {
    return `create note responded ${String(response.status)}`
  }
}

export function useCreateNote(onFailure: (message: string) => void): {
  readonly state: CreateNoteState
  /** Validate → optimistic insert → POST → reconcile or rollback. */
  readonly submit: (input: { readonly title: string }) => Promise<SubmitOutcome>
} {
  const [state, dispatch] = useReducer(createNoteReducer, CREATE_NOTE_INITIAL)
  // Single-flight: the composer disables its button while pending; this ref
  // backstops against a second entry point racing the same reducer.
  const inFlight = useRef(false)

  const submit = useCallback(
    async (input: { readonly title: string }): Promise<SubmitOutcome> => {
      if (inFlight.current) return 'rejected'
      // Zod at the fetch boundary: invalid input never reaches the network and
      // never inserts a row — the contract's own message renders inline.
      const parsed = NewNoteInput.safeParse(input)
      if (!parsed.success) {
        dispatch({ type: 'reject', message: parsed.error.issues[0]?.message ?? 'invalid input' })
        return 'rejected'
      }
      // Temp id in the same uuid shape the server mints, so reconcile-by-id is
      // uniform and the DOM key never changes semantics.
      const tempId = crypto.randomUUID()
      inFlight.current = true
      dispatch({ type: 'start', row: { id: tempId, title: parsed.data.title, pending: true } })
      try {
        const response = await fetch(`${API_ORIGIN}/api/notes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed.data),
        })
        if (!response.ok) {
          dispatch({ type: 'fail', tempId })
          onFailure(await envelopeMessage(response))
          return 'failed'
        }
        const note = NoteDto.parse(await response.json())
        dispatch({
          type: 'settle',
          tempId,
          row: { id: note.id, title: note.title, pending: false },
        })
        return 'settled'
      } catch (cause) {
        dispatch({ type: 'fail', tempId })
        onFailure(cause instanceof Error ? cause.message : String(cause))
        return 'failed'
      } finally {
        inFlight.current = false
      }
    },
    [onFailure],
  )

  return { state, submit }
}
