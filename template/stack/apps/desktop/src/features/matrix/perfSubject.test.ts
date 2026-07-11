import { describe, expect, it } from 'vitest'
import { MATRIX_COLUMNS } from './matrixData'
import { renderSubject } from './perfSubject'

describe('perfSubject', () => {
  it('renders every gridcell for the requested cell count (the perf budget subject)', () => {
    const cells = 120
    const html = renderSubject(cells)
    const rowCount = Math.round(cells / MATRIX_COLUMNS.length)
    const gridcells = (html.match(/role="gridcell"/g) ?? []).length
    expect(gridcells).toBe(rowCount * MATRIX_COLUMNS.length)
    expect(html).toContain('role="grid"')
  })
})
