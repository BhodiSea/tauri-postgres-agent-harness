import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MatrixGrid } from './MatrixGrid'
import { MATRIX_COLUMNS, makeSyntheticRows } from './matrixData'
import { ROW_HEIGHT } from './useVirtualWindow'

// Perf-budget subject — an ISLAND. Nothing reachable from main.tsx may import
// react-dom/server (bundle purity, enforced by the build gate), so this module is
// imported only by its own unit test and, next stage, the perf-budget gate's CLI.
// renderSubject forces the entire grid into the virtual window (viewportHeight =
// full height) so every gridcell is materialized — that full render is what the
// median render budget measures.
export function renderSubject(cells: number): string {
  const columnCount = MATRIX_COLUMNS.length
  const rowCount = Math.max(1, Math.round(cells / columnCount))
  const rows = makeSyntheticRows(rowCount)
  return renderToString(
    createElement(MatrixGrid, {
      rows,
      columns: MATRIX_COLUMNS,
      active: { row: 0, col: 0 },
      onKeyDown: () => undefined,
      viewportHeight: rowCount * ROW_HEIGHT,
    }),
  )
}
