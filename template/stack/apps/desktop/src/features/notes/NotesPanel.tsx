import { type Note, NotesPage } from '@app/schema'
import { ROUTES } from '../../routes'
import { type ListFetcher, type ListQueryState, useListQuery } from './useListQuery'

// The home screen's data panel — the reference implementation of the three
// canonical data states every route declares in src/routes.ts: the loading,
// empty, and error surfaces each render the manifest's data-testid, and the
// error surface carries a working retry affordance. e2e/states.spec.ts drives
// all three via API stubs; App.test.tsx covers them under jsdom.
// SOURCE: harness doctrine — degraded/empty/loading states are a first-class
// UI concern, never a blank panel [corpus: harness/doctrine]

// Dev override via Vite env; otherwise the API origin baked into the committed
// CSP (tauri.conf.json connect-src) at install time.
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '{{API_ORIGIN}}'

// Zod parse at the fetch boundary — the desktop trusts contracts, not wire
// bytes. Keyset pagination: the scaffold panel renders the FIRST page; wire
// `nextCursor` into a paged list when the product needs one.
const fetchNotes: ListFetcher<Note> = async (signal) => {
  const response = await fetch(`${API_ORIGIN}/api/notes`, { signal })
  if (!response.ok) throw new Error(`notes responded ${String(response.status)}`)
  return NotesPage.parse(await response.json()).items
}

// The scaffold's only screen; its manifest entry carries the state test ids.
const [HOME] = ROUTES

function NotesBody({
  state,
  onRetry,
}: {
  readonly state: ListQueryState<Note>
  readonly onRetry: () => void
}) {
  if (state.status === 'loading') {
    return (
      <p
        data-testid={HOME.states.loading}
        className="mt-3 text-sm text-ink-muted motion-safe:animate-pulse"
      >
        Loading notes…
      </p>
    )
  }
  if (state.status === 'empty') {
    return (
      <p data-testid={HOME.states.empty} className="mt-3 text-sm text-ink-muted">
        No notes yet — the first note you create will appear here.
      </p>
    )
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
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-edge px-2 py-1 text-xs font-medium hover:text-accent"
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {state.items.map((note) => (
        <li key={note.id} className="rounded border border-edge bg-canvas px-3 py-2 text-sm">
          {note.title}
        </li>
      ))}
    </ul>
  )
}

export function NotesPanel() {
  const { state, reload } = useListQuery(fetchNotes)

  return (
    <section
      aria-labelledby="notes-heading"
      className="w-full max-w-md rounded-lg border border-edge bg-surface p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="notes-heading" className="text-base font-medium">
          Notes
        </h2>
        <button
          type="button"
          onClick={reload}
          className="rounded border border-edge px-2 py-1 text-xs text-ink-muted hover:text-ink"
        >
          Reload
        </button>
      </div>
      <NotesBody state={state} onRetry={reload} />
    </section>
  )
}
