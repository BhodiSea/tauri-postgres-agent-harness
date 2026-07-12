import { type Note, NotesPage } from '@app/schema'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Skeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import { cn } from '../../lib/utils'
import { ROUTES } from '../../routes'
import { NoteComposer } from './NoteComposer'
import { type ComposerRow, useCreateNote } from './useCreateNote'
import { type ListFetcher, type ListQueryState, useListQuery } from './useListQuery'

// The home screen's data panel — the reference implementation of the three
// canonical data states every route declares in src/routes.ts, now expressed
// through the shared primitives: Skeleton (loading), EmptyState (empty), and a
// retry Button (error). The loading/empty/error surfaces each render the
// manifest's data-testid, and the error surface carries a working retry
// affordance. e2e/states.spec.ts drives all three via API stubs; App.test.tsx
// covers them under jsdom. The panel is also the WRITE exemplar: NoteComposer +
// useCreateNote insert an optimistic pending row at the head of this list and
// reconcile or roll it back (e2e/mutation.spec.ts drives both paths).
// SOURCE: harness doctrine — degraded/empty/loading states are a first-class
// UI concern, never a blank panel [corpus: harness/doctrine]

// Dev override via Vite env; otherwise the API origin baked into the committed
// CSP (tauri.conf.json connect-src) at install time.
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '{{API_ORIGIN}}'

// Zod parse at the fetch boundary — the desktop trusts contracts, not wire
// bytes. Keyset pagination: the scaffold panel renders the FIRST page; the matrix
// screen (features/matrix/useKeysetQuery) shows the paged variant.
const fetchNotes: ListFetcher<Note> = async (signal) => {
  const response = await fetch(`${API_ORIGIN}/api/notes`, { signal })
  if (!response.ok) throw new Error(`notes responded ${String(response.status)}`)
  return NotesPage.parse(await response.json()).items
}

// The scaffold's home screen; its manifest entry carries the state test ids.
const [HOME] = ROUTES

// Pending rows keep full-contrast tokens (ink-muted stays >= 4.5:1 in both
// themes) — the provisional look is the dashed edge + muted ink, never an
// opacity fade that could dip under AA mid-flight.
function NoteRowItem({ row }: { readonly row: ComposerRow }) {
  return (
    <li
      data-note-id={row.id}
      data-pending={row.pending ? 'true' : undefined}
      className={cn(
        'rounded border border-edge bg-canvas px-3 py-2 text-sm',
        row.pending && 'border-dashed text-ink-muted',
      )}
    >
      {row.title}
    </li>
  )
}

function NotesBody({
  state,
  onRetry,
  overlay,
}: {
  readonly state: ListQueryState<Note>
  readonly onRetry: () => void
  /** Optimistic rows from useCreateNote, rendered ahead of the fetched page. */
  readonly overlay: readonly ComposerRow[]
}) {
  if (state.status === 'loading') {
    return <Skeleton data-testid={HOME.states.loading} lines={3} className="mt-3" />
  }
  if (state.status === 'error') {
    return (
      <div
        data-testid={HOME.states.error}
        role="alert"
        className="mt-3 rounded-md border border-edge bg-canvas p-3"
      >
        <p className="text-sm">Could not load notes.</p>
        <p className="mt-1 font-mono text-xs text-ink-muted">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  const items = state.status === 'ready' ? state.items : []
  // A reconciled row can reappear in a reloaded page — the fetched row wins.
  const optimistic = overlay.filter((row) => !items.some((note) => note.id === row.id))
  if (state.status === 'empty' && optimistic.length === 0) {
    return (
      <EmptyState
        data-testid={HOME.states.empty}
        className="mt-3"
        title="No notes yet"
        description="The first note you create will appear here."
        cta={{ label: 'Reload', onClick: onRetry }}
      />
    )
  }
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {optimistic.map((row) => (
        <NoteRowItem key={row.id} row={row} />
      ))}
      {items.map((note) => (
        <NoteRowItem key={note.id} row={{ id: note.id, title: note.title, pending: false }} />
      ))}
    </ul>
  )
}

export function NotesPanel() {
  const { state, reload } = useListQuery(fetchNotes)
  const toast = useToast()
  // Write failures surface as envelope-message toasts — same seam as the
  // matrix screen's failed loadMore.
  const { state: createState, submit } = useCreateNote(toast.show)

  return (
    <section
      aria-labelledby="notes-heading"
      className="w-full max-w-md rounded-lg border border-edge bg-surface p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="notes-heading" className="text-base font-medium">
          Notes
        </h2>
        <Button variant="outline" size="sm" onClick={reload}>
          Reload
        </Button>
      </div>
      {/* Composer above the list: the optimistic row lands at the list head,
          directly under the form that created it. */}
      <NoteComposer
        status={createState.status}
        fieldError={createState.fieldError}
        onSubmit={submit}
      />
      <NotesBody state={state} onRetry={reload} overlay={createState.rows} />
    </section>
  )
}
