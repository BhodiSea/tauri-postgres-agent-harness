import { describe, expect, it } from 'vitest'
import { computeWindow, ROW_HEIGHT } from './useVirtualWindow'

describe('computeWindow', () => {
  it('ROW_HEIGHT is a unitless number', () => {
    expect(ROW_HEIGHT).toBe(36)
  })

  it('returns an empty window for zero rows or a zero-height viewport', () => {
    expect(
      computeWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 36, rowCount: 0, overscan: 2 }),
    ).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
    expect(
      computeWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: 36, rowCount: 10, overscan: 2 }),
    ).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 360 })
  })

  it('windows the visible slice plus overscan at the top', () => {
    const w = computeWindow({
      scrollTop: 0,
      viewportHeight: 108,
      rowHeight: 36,
      rowCount: 100,
      overscan: 2,
    })
    expect(w.start).toBe(0)
    // visibleCount = ceil(108/36) = 3; end = 0 + 3 + 2 + 1 = 6
    expect(w.end).toBe(6)
    expect(w.offsetY).toBe(0)
    expect(w.totalHeight).toBe(3600)
  })

  it('offsets and overscans both sides when scrolled into the middle', () => {
    const w = computeWindow({
      scrollTop: 360,
      viewportHeight: 108,
      rowHeight: 36,
      rowCount: 100,
      overscan: 2,
    })
    // firstVisible = 10; start = 8; end = 10 + 3 + 2 + 1 = 16
    expect(w.start).toBe(8)
    expect(w.end).toBe(16)
    expect(w.offsetY).toBe(8 * 36)
  })

  it('clamps an over-scroll to the last page and never exceeds rowCount', () => {
    const w = computeWindow({
      scrollTop: 999_999,
      viewportHeight: 108,
      rowHeight: 36,
      rowCount: 10,
      overscan: 2,
    })
    expect(w.end).toBe(10)
    expect(w.start).toBeGreaterThanOrEqual(0)
    expect(w.start).toBeLessThanOrEqual(w.end)
  })
})
