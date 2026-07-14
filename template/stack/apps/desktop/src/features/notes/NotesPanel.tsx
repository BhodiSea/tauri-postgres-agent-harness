import { type Note, NotesPage } from '@app/schema'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Skeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import { formatDate, formatRelativeTime, useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api-client'
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

// Zod parse at the fetch boundary — the desktop trusts contracts, not wire
// bytes. Keyset pagination: the scaffold panel renders the FIRST page; the matrix
// screen (features/matrix/useKeysetQuery) shows the paged variant. apiFetch carries
// the bearer token and throws the envelope's own message, which useListQuery carries
// as `state.message` and NotesBody renders as the error state's SECONDARY technical
// line — the PRIMARY copy is always t('notes.error.title') from the catalog.
const fetchNotes: ListFetcher<Note> = async (signal) => {
  try {
    const response = await apiFetch('/api/notes', { signal })
    return NotesPage.parse(await response.json()).items
  } catch (cause) {
    // No special-casing here any more. This used to rethrow UnauthenticatedError as a
    // hand-written English sentence — the one error in the app that got a human explanation,
    // and only on this screen. translateError() now maps the envelope's `code` to catalog
    // copy for EVERY surface, so a signed-out session reads the same (translated) way in the
    // matrix, in a toast, and here. One mapping, not one per call site.
    throw cause
  }
}

// The scaffold's home screen; its manifest entry carries the state test ids.
const [HOME] = ROUTES

// Pending rows keep full-contrast tokens (ink-muted stays >= 4.5:1 in both
// themes) — the provisional look is the dashed edge + muted ink, never an
// opacity fade that could dip under AA mid-flight.
function NoteRowItem({ row }: { readonly row: ComposerRow }) {
  const { t } = useI18n()
  return (
    <li
      data-note-id={row.id}
      data-pending={row.pending ? 'true' : undefined}
      className={cn(
        'rounded border border-edge bg-canvas px-3 py-2 text-sm',
        row.pending && 'border-dashed text-ink-muted',
      )}
    >
      {/* The title is its OWN element, not a bare text node in the <li>. Once the row grew a
          timestamp, the <li>'s text content became "Note 1Created 3 minutes ago" — and every
          exact-text assertion in the e2e suite (and any screen reader reading the row as one
          run) saw the two glued together. */}
      <span className="block">{row.title}</span>
      {/* The creation time, phrased the way the locale phrases it ("3 minutes ago", "hace 3
          minutos", "منذ ٣ دقائق") — Intl.RelativeTimeFormat, not a hand-rolled "N ago" that
          would be English grammar wearing a translation. A pending row has no timestamp yet
          (the server assigns it), so it shows none rather than a guess that will change. */}
      {row.createdAt !== null && (
        <time
          dateTime={row.createdAt}
          // Relative time is what a human wants to READ ("3 minutes ago"); the exact instant is
          // what they occasionally need to KNOW. Both go through Intl, so both are the locale's.
          title={formatDate(row.createdAt, { dateStyle: 'long', timeStyle: 'short' })}
          className="mt-0.5 block text-xs text-ink-muted"
        >
          {t('notes.createdAt', { when: formatRelativeTime(row.createdAt) })}
        </time>
      )}
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
  const { t } = useI18n()
  if (state.status === 'loading') {
    return <Skeleton data-testid={HOME.states.loading} lines={3} className="mt-3" />
  }
  if (state.status === 'error') {
    return (
      <div
        data-testid={HOME.states.error}
        role="alert"
        // border-danger, not border-edge: the failure surface used to be the same box as
        // the empty state. The message text stays `text-ink` (AAA) — colour is the
        // redundant channel, never the only one.
        className="mt-3 rounded-md border border-danger bg-canvas p-3"
      >
        {/* THREE registers, and the distinction is the point.
              1. WHAT failed — catalog copy, always the same sentence for this surface.
              2. WHY — also catalog copy, but SELECTED BY THE ENVELOPE'S `code`: "You are not
                 signed in." reads very differently from "Something went wrong on the server.",
                 and the client can only say either because the server's error contract carries
                 a stable code. Until 0.1.6 this line did not exist and register 3 was the
                 primary sentence.
              3. The raw failure text — an envelope message, a TypeError, an offline socket.
                 Untranslatable by nature (it is whatever the failure said), so it stays quiet
                 and monospaced, next to the request id. It is kept, not hidden: it is what
                 turns "it failed" into a bug someone can trace. */}
        <p className="text-sm">{t('notes.error.title')}</p>
        <p className="mt-1 text-sm text-ink">{state.error.message}</p>
        {state.error.detail !== null && state.error.detail !== '' && (
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {state.error.detail}
            {state.error.requestId !== null &&
              ` — ${t('error.reference', { id: state.error.requestId })}`}
          </p>
        )}
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
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
        title={t('notes.empty.title')}
        description={t('notes.empty.description')}
        cta={{ label: t('common.reload'), onClick: onRetry }}
      />
    )
  }
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {optimistic.map((row) => (
        <NoteRowItem key={row.id} row={row} />
      ))}
      {items.map((note) => (
        <NoteRowItem
          key={note.id}
          row={{ id: note.id, title: note.title, pending: false, createdAt: note.createdAt }}
        />
      ))}
    </ul>
  )
}

export function NotesPanel() {
  const { state, reload } = useListQuery(fetchNotes)
  const { t } = useI18n()
  const toast = useToast()
  // Write failures surface as envelope-message toasts — same seam as the
  // matrix screen's failed loadMore.
  // 'error', not the default info tone: a failed write is the one message in this app a
  // user must not scroll past, and it used to render in exactly the same pixels as
  // "Theme: dark".
  const { state: createState, submit } = useCreateNote((message) => {
    toast.show(message, 'error')
  })

  return (
    <section
      aria-labelledby="notes-heading"
      className="w-full max-w-md rounded-lg border border-edge bg-surface p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="notes-heading" className="text-base font-medium">
          {t('notes.heading')}
        </h2>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('common.reload')}
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
