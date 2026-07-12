import { useEffect } from 'react'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Skeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
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
  const { state, loadMore, reload } = useKeysetQuery((message) => {
    toast.show(`Could not load more rows: ${message}`)
  })
  const rows = notesToMatrixRows(state.rows)
  const roving = useRovingGrid({
    rowCount: rows.length,
    colCount: MATRIX_COLUMNS.length + 1,
    pageRows: 10,
  })

  // This screen's palette contributions. Every dependency is identity-stable
  // (setActive is a raw useState setter, reload is useCallback'd, App's
  // registerCommands is a raw setter), so this registers ONCE on mount and the
  // cleanup withdraws the commands on unmount — the palette never advertises a
  // dead matrix command from another screen. "Jump to top" drives the grid's
  // real follow-focus seam: setActive(0,0) scrolls the virtual window to the
  // top and moves the roving focus onto the first cell.
  const setActive = roving.setActive
  useEffect(() => {
    const contributions: readonly Command[] = [
      {
        id: 'matrix.jump-top',
        title: 'Jump to top',
        group: 'Matrix',
        subtitle: 'First cell',
        run: () => {
          setActive({ row: 0, col: 0 })
        },
      },
      {
        id: 'matrix.reload',
        title: 'Reload matrix rows',
        group: 'Matrix',
        subtitle: 'From page one',
        run: reload,
      },
    ]
    registerCommands(contributions)
    return () => {
      registerCommands([])
    }
  }, [registerCommands, setActive, reload])

  if (state.status === 'loading') {
    return <Skeleton data-testid={MATRIX.states.loading} lines={8} className="max-w-2xl p-8" />
  }
  if (state.status === 'empty') {
    return (
      <EmptyState
        data-testid={MATRIX.states.empty}
        className="p-8"
        title="No rows to chart yet"
        description="Once notes exist, their numeric columns appear here as a dense, virtualized matrix."
        cta={{ label: 'Reload', onClick: reload }}
      />
    )
  }
  if (state.status === 'error') {
    return (
      <div
        data-testid={MATRIX.states.error}
        role="alert"
        className="m-8 rounded-md border border-edge bg-canvas p-4"
      >
        <p className="text-sm">Could not load the matrix.</p>
        <p className="mt-1 font-mono text-xs text-ink-muted">{state.message}</p>
        <Button size="sm" className="mt-3" onClick={reload}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-4 p-8">
      <div>
        <h2 className="text-base font-medium">Matrix</h2>
        <p className="mt-1 text-sm text-ink-muted">
          {rows.length} rows × {MATRIX_COLUMNS.length} columns, virtualized.
        </p>
      </div>
      <MatrixSummary rows={rows} columnLabel={MATRIX_COLUMNS[0]?.label ?? 'value'} />
      <MatrixGrid
        rows={rows}
        columns={MATRIX_COLUMNS}
        active={roving.active}
        onKeyDown={roving.onKeyDown}
        onNearEnd={loadMore}
      />
      {state.loadMoreFailed && (
        <p role="alert" className="text-sm text-ink-muted">
          Loading more failed.{' '}
          <Button size="sm" variant="outline" onClick={loadMore}>
            Retry
          </Button>
        </p>
      )}
      {state.cursor !== null && (
        <div>
          <Button size="sm" onClick={loadMore} disabled={state.loadingMore}>
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
