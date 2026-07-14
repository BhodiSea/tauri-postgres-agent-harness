import { useEffect } from 'react'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Skeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import { translate, useI18n } from '../../i18n'
import { ROUTES } from '../../routes'
import type { Command, RegisterCommands } from '../palette/CommandPalette'
import { MatrixGrid } from './MatrixGrid'
import { MatrixSummary } from './MatrixSummary'
import { MATRIX_COLUMNS, notesToMatrixRows } from './matrixData'
import { useKeysetQuery } from './useKeysetQuery'
import { useRovingGrid } from './useRovingGrid'

// The matrix route's screen. Same three canonical data states as the home panel
// (loading/empty/error test ids from src/routes.ts, driven by e2e/states.spec),
// then the ready surface: a distribution strip, the virtualized grid, and a
// keyboard-reachable Load-more control that mirrors the near-end scroll trigger.
function matrixRoute() {
  const route = ROUTES.find((entry) => entry.id === 'matrix')
  if (route === undefined) throw new Error('routes.ts must register the "matrix" route')
  return route
}
const MATRIX = matrixRoute()

interface MatrixPanelProps {
  /** Contextual-palette registration callback — see CommandPalette.tsx. */
  readonly registerCommands: RegisterCommands
}

export function MatrixPanel({ registerCommands }: MatrixPanelProps) {
  const toast = useToast()
  const { t, locale } = useI18n()
  const { state, loadMore, reload } = useKeysetQuery((message) => {
    // `message` is the server's envelope text — a developer/support detail we
    // interpolate, never copy we author. The sentence around it is the catalog's.
    toast.show(t('matrix.loadMore.toast', { message }), 'error')
  })
  const rows = notesToMatrixRows(state.rows)
  const roving = useRovingGrid({
    rowCount: rows.length,
    colCount: MATRIX_COLUMNS.length + 1,
    pageRows: 10,
  })

  // This screen's palette contributions. Every dependency is identity-stable
  // (setActive is a raw useState setter, reload is useCallback'd, App's
  // registerCommands is a raw setter), so this registers ONCE on mount — plus
  // once more per locale switch, and ONLY then — and the cleanup withdraws the
  // commands on unmount, so the palette never advertises a dead matrix command
  // from another screen. "Jump to top" drives the grid's real follow-focus seam:
  // setActive(0,0) scrolls the virtual window to the top and moves the roving
  // focus onto the first cell.
  //
  // The copy resolves through `translate(locale, …)`, NOT the `t` from useI18n,
  // and that is load-bearing rather than stylistic. useI18n's `t` closes over the
  // locale, so it is a NEW function every render; exhaustive-deps (an error here)
  // would force it into the array below, and this effect calls registerCommands
  // with a freshly-built array, which is a setState in App — re-render, new `t`,
  // effect re-runs, forever. `translate` is a module import (stable), and `locale`
  // is the string this effect genuinely depends on: it re-registers exactly when
  // the language changes, which is what keeps the palette's commands translated.
  const setActive = roving.setActive
  useEffect(() => {
    const contributions: readonly Command[] = [
      {
        id: 'matrix.jump-top',
        title: translate(locale, 'command.matrix.top'),
        group: 'matrix',
        subtitle: translate(locale, 'command.matrix.top.subtitle'),
        run: () => {
          setActive({ row: 0, col: 0 })
        },
      },
      {
        id: 'matrix.reload',
        title: translate(locale, 'command.matrix.reload'),
        group: 'matrix',
        subtitle: translate(locale, 'command.matrix.reload.subtitle'),
        run: reload,
      },
    ]
    registerCommands(contributions)
    return () => {
      registerCommands([])
    }
  }, [registerCommands, setActive, reload, locale])

  if (state.status === 'loading') {
    return <Skeleton data-testid={MATRIX.states.loading} lines={8} className="max-w-2xl p-8" />
  }
  if (state.status === 'empty') {
    return (
      <EmptyState
        data-testid={MATRIX.states.empty}
        className="p-8"
        title={t('matrix.empty.title')}
        description={t('matrix.empty.description')}
        cta={{ label: t('common.reload'), onClick: reload }}
      />
    )
  }
  if (state.status === 'error') {
    return (
      <div
        data-testid={MATRIX.states.error}
        role="alert"
        // border-danger: the failure surface must not be the same box as the empty one.
        className="m-8 rounded-md border border-danger bg-canvas p-4"
      >
        {/* Three registers — the same contract NotesPanel documents: WHAT failed (catalog),
            WHY (catalog copy selected by the envelope's stable `code`), and the raw failure
            text, which is untranslatable by nature and stays in the font that says so. */}
        <p className="text-sm">{t('matrix.error.title')}</p>
        {state.error !== null && <p className="mt-1 text-sm text-ink">{state.error.message}</p>}
        {state.error !== null && state.error.detail !== null && state.error.detail !== '' && (
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {state.error.detail}
            {state.error.requestId !== null &&
              ` — ${t('error.reference', { id: state.error.requestId })}`}
          </p>
        )}
        <Button size="sm" className="mt-3" onClick={reload}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-4 p-8">
      <div>
        <h2 className="text-base font-medium">{t('matrix.heading')}</h2>
        {/* One key, not a sentence assembled from fragments: `count` picks the
            plural branch via Intl.PluralRules, so a single-row matrix no longer
            reads "1 rows" — and a language whose rule is not English's two-form
            split gets its own branch from the catalog, with no change here. */}
        <p className="mt-1 text-sm text-ink-muted">
          {t('matrix.summary', {
            count: rows.length,
            rows: rows.length,
            columns: MATRIX_COLUMNS.length,
          })}
        </p>
      </div>
      <MatrixSummary
        rows={rows}
        columnLabel={t(MATRIX_COLUMNS[0]?.labelKey ?? 'matrix.column.value')}
      />
      <MatrixGrid
        rows={rows}
        columns={MATRIX_COLUMNS}
        active={roving.active}
        onKeyDown={roving.onKeyDown}
        onNearEnd={loadMore}
      />
      {state.loadMoreFailed && (
        <p role="alert" className="text-sm text-ink-muted">
          {t('matrix.loadMore.failed')}{' '}
          <Button size="sm" variant="outline" onClick={loadMore}>
            {t('common.retry')}
          </Button>
        </p>
      )}
      {state.cursor !== null && (
        <div>
          <Button size="sm" onClick={loadMore} disabled={state.loadingMore}>
            {state.loadingMore ? t('matrix.loadingMore') : t('matrix.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
