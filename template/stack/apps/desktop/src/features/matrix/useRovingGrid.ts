import { type KeyboardEvent, useState } from 'react'

// APG grid keyboard model: the grid is ONE tab stop (roving tabindex), and the
// arrow keys / Home / End / Ctrl+Home / Ctrl+End / Page Up / Page Down move the
// active cell. This hook owns the active {row,col} and turns key events into the
// next position; MatrixGrid receives `active` as a plain prop and follows focus
// into the virtual window.
// SOURCE: WAI-ARIA APG grid pattern — single tab stop, arrow/Home/End/Page
// navigation [corpus: wai-aria/apg-grid]

export interface GridPosition {
  /** 0-based data-row index (excludes the column-header row). */
  readonly row: number
  /** 0-based column index; column 0 is the row-header (label) column. */
  readonly col: number
}

export interface GridDimensions {
  readonly rowCount: number
  readonly colCount: number
  /** Rows moved per Page Up / Page Down. */
  readonly pageRows: number
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, value), Math.max(0, max))
}

/**
 * Pure: the next active cell for a key, or null if the key is not a grid move.
 * `ctrl` distinguishes Home/End (row ends) from Ctrl+Home/Ctrl+End (grid corners).
 */
function nextPosition(
  active: GridPosition,
  key: string,
  ctrl: boolean,
  dims: GridDimensions,
): GridPosition | null {
  const lastRow = dims.rowCount - 1
  const lastCol = dims.colCount - 1
  switch (key) {
    case 'ArrowRight':
      return { row: active.row, col: clamp(active.col + 1, lastCol) }
    case 'ArrowLeft':
      return { row: active.row, col: clamp(active.col - 1, lastCol) }
    case 'ArrowDown':
      return { row: clamp(active.row + 1, lastRow), col: active.col }
    case 'ArrowUp':
      return { row: clamp(active.row - 1, lastRow), col: active.col }
    case 'Home':
      return ctrl ? { row: 0, col: 0 } : { row: active.row, col: 0 }
    case 'End':
      return ctrl ? { row: lastRow, col: lastCol } : { row: active.row, col: lastCol }
    case 'PageDown':
      return { row: clamp(active.row + dims.pageRows, lastRow), col: active.col }
    case 'PageUp':
      return { row: clamp(active.row - dims.pageRows, lastRow), col: active.col }
    default:
      return null
  }
}

export interface RovingGrid {
  readonly active: GridPosition
  readonly setActive: (position: GridPosition) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export function useRovingGrid(dims: GridDimensions): RovingGrid {
  const [active, setActive] = useState<GridPosition>({ row: 0, col: 0 })
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next = nextPosition(active, event.key, event.ctrlKey || event.metaKey, dims)
    if (next === null) return
    event.preventDefault()
    setActive(next)
  }
  return { active, setActive, onKeyDown }
}
