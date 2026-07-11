import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MatrixGrid } from './MatrixGrid'
import { MATRIX_COLUMNS, makeSyntheticRows } from './matrixData'

const rows = makeSyntheticRows(100)
const noop = (): void => undefined

describe('MatrixGrid', () => {
  it('renders only the windowed slice, not all 100 rows, and declares the true size', () => {
    render(
      <MatrixGrid
        rows={rows}
        columns={MATRIX_COLUMNS}
        active={{ row: 0, col: 0 }}
        onKeyDown={noop}
        viewportHeight={180}
      />,
    )
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('aria-rowcount')).toBe('101') // 100 data + 1 header
    expect(grid.getAttribute('aria-colcount')).toBe(String(MATRIX_COLUMNS.length + 1))
    const renderedRows = screen.getAllByRole('row')
    expect(renderedRows.length).toBeGreaterThan(1)
    expect(renderedRows.length).toBeLessThan(20)
  })

  it('marks exactly the active cell (prop-driven) as the single tab stop', () => {
    render(
      <MatrixGrid
        rows={rows}
        columns={MATRIX_COLUMNS}
        active={{ row: 0, col: 2 }}
        onKeyDown={noop}
        viewportHeight={180}
      />,
    )
    const tabbable = document.querySelectorAll('[role="gridcell"][tabindex="0"]')
    expect(tabbable.length).toBe(1)
    expect(tabbable[0]?.getAttribute('data-row')).toBe('0')
    expect(tabbable[0]?.getAttribute('data-col')).toBe('2')
  })

  it('numbers data rows with aria-rowindex offset by the header row', () => {
    render(
      <MatrixGrid
        rows={rows}
        columns={MATRIX_COLUMNS}
        active={{ row: 0, col: 0 }}
        onKeyDown={noop}
        viewportHeight={180}
      />,
    )
    const dataRows = screen
      .getAllByRole('row')
      .filter((row) => row.getAttribute('aria-rowindex') !== '1')
    expect(dataRows[0]?.getAttribute('aria-rowindex')).toBe('2')
  })
})
