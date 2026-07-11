import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { formatCell, type MatrixColumn, type MatrixRow } from './matrixData'
import type { GridPosition } from './useRovingGrid'
import { computeWindow, ROW_HEIGHT, useScrollTop } from './useVirtualWindow'

// Presentational virtualized grid. Pure inputs → DOM: it renders only the row
// slice inside the viewport (aria-rowcount/aria-rowindex tell AT the true size),
// wires the APG grid roles, and follows keyboard focus into the window. The one
// inline-style file in the desktop app (styleguide manifest allow entry): the
// virtual window is positioned with transform/height, which cannot be a token
// utility. Hot cell classes are plain template literals (no cn()) to keep the
// per-cell path allocation-free.
// SOURCE: WAI-ARIA APG grid — virtualized rows keep aria-rowcount + per-row
// aria-rowindex so assistive tech reports true size and position
// [corpus: wai-aria/apg-grid]

const OVERSCAN = 6
// How close to the bottom (in rows) before asking for the next page.
const NEAR_END_ROWS = 8
// h-9 == 36px == ROW_HEIGHT; the window math and the row height must agree.
const ROW_HEIGHT_CLASS = 'h-9'

interface MatrixGridProps {
  readonly rows: readonly MatrixRow[]
  readonly columns: readonly MatrixColumn[]
  readonly active: GridPosition
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  /** Fixed viewport height — supplied by the perf subject so SSR renders every
   *  row deterministically; omitted in the app, where it is measured. */
  readonly viewportHeight?: number
  /** Called when the user scrolls within NEAR_END_ROWS of the bottom. */
  readonly onNearEnd?: () => void
}

export function MatrixGrid({
  rows,
  columns,
  active,
  onKeyDown,
  viewportHeight,
  onNearEnd,
}: MatrixGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoHeight, setAutoHeight] = useState(0)
  const scrollTop = useScrollTop(scrollRef)

  // Measure the scroll container unless the caller fixed the viewport (SSR/perf).
  useEffect(() => {
    if (viewportHeight !== undefined) return undefined
    const element = scrollRef.current
    if (element === null) return undefined
    const measure = (): void => {
      setAutoHeight(element.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [viewportHeight])

  const viewport = viewportHeight ?? autoHeight
  const { start, end, offsetY, totalHeight } = computeWindow({
    scrollTop,
    viewportHeight: viewport,
    rowHeight: ROW_HEIGHT,
    rowCount: rows.length,
    overscan: OVERSCAN,
  })

  // Follow the active cell: focus it when it is inside the window, otherwise
  // scroll it in (which re-runs this effect once the window has advanced).
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (active.row < start || active.row >= end) {
      element.scrollTop = active.row * ROW_HEIGHT
      return
    }
    const cell = element.querySelector<HTMLElement>(
      `[data-row="${String(active.row)}"][data-col="${String(active.col)}"]`,
    )
    cell?.focus({ preventScroll: true })
  }, [active, start, end])

  // Infinite-scroll trigger — loadMore itself single-flights, so a repeated fire
  // while parked at the bottom is harmless.
  const nearEnd = scrollTop + viewport >= totalHeight - NEAR_END_ROWS * ROW_HEIGHT
  useEffect(() => {
    if (onNearEnd !== undefined && nearEnd && rows.length > 0) onNearEnd()
  }, [nearEnd, onNearEnd, rows.length])

  const totalRows = rows.length + 1
  const totalCols = columns.length + 1
  const gridTemplateColumns = `minmax(0, 12rem) repeat(${String(columns.length)}, minmax(0, 1fr))`
  const windowed = rows.slice(start, end)

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Notes matrix"
      aria-rowcount={totalRows}
      aria-colcount={totalCols}
      // Roving tabindex: the grid is programmatically focusable (-1) but never a
      // tab stop — exactly one CELL carries tabIndex 0. onKeyDown lives here so
      // arrow keys bubble up from whichever cell is focused.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="h-96 overflow-auto rounded-lg border border-edge bg-surface"
    >
      <div role="rowgroup" className="sticky top-0 z-10 bg-surface">
        <div
          role="row"
          aria-rowindex={1}
          className={`grid ${ROW_HEIGHT_CLASS} items-center border-b border-edge`}
          style={{ gridTemplateColumns }}
        >
          <span
            role="columnheader"
            aria-colindex={1}
            className="truncate px-3 text-xs font-semibold"
          >
            Note
          </span>
          {columns.map((column, c) => (
            <span
              key={column.key}
              role="columnheader"
              aria-colindex={c + 2}
              className="truncate px-3 text-right text-xs font-semibold"
            >
              {column.label}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup" style={{ height: totalHeight }}>
        <div role="presentation" style={{ transform: `translateY(${String(offsetY)}px)` }}>
          {windowed.map((row, i) => {
            const dataRow = start + i
            const labelActive = active.row === dataRow && active.col === 0
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={dataRow + 2}
                className={`grid ${ROW_HEIGHT_CLASS} items-center border-b border-edge`}
                style={{ gridTemplateColumns }}
              >
                <span
                  role="rowheader"
                  aria-colindex={1}
                  data-row={dataRow}
                  data-col={0}
                  tabIndex={labelActive ? 0 : -1}
                  className={`truncate px-3 text-sm ${labelActive ? 'bg-surface text-ink' : 'text-ink-muted'}`}
                >
                  {row.label}
                </span>
                {columns.map((column, c) => {
                  const col = c + 1
                  const value = row.values[c] ?? 0
                  const cellActive = active.row === dataRow && active.col === col
                  return (
                    <span
                      key={column.key}
                      role="gridcell"
                      aria-colindex={col + 1}
                      data-row={dataRow}
                      data-col={col}
                      tabIndex={cellActive ? 0 : -1}
                      className={`px-3 text-right text-sm tabular-nums ${cellActive ? 'bg-surface text-ink' : 'text-ink-muted'}`}
                    >
                      {formatCell(value)}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
