import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type GridDimensions, type GridPosition, useRovingGrid } from './useRovingGrid'

const dims: GridDimensions = { rowCount: 5, colCount: 4, pageRows: 3 }

function keyEvent(
  key: string,
  ctrl = false,
): { event: KeyboardEvent<HTMLElement>; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn()
  const event = {
    key,
    ctrlKey: ctrl,
    metaKey: false,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLElement>
  return { event, preventDefault }
}

// Drive the roving hook through its public onKeyDown from a given start cell.
function drive(start: GridPosition, key: string, ctrl = false): GridPosition {
  const { result } = renderHook(() => useRovingGrid(dims))
  act(() => {
    result.current.setActive(start)
  })
  const { event } = keyEvent(key, ctrl)
  act(() => {
    result.current.onKeyDown(event)
  })
  return result.current.active
}

describe('useRovingGrid', () => {
  it('starts at the grid origin', () => {
    const { result } = renderHook(() => useRovingGrid(dims))
    expect(result.current.active).toEqual({ row: 0, col: 0 })
  })

  it('arrow keys move within bounds and clamp at the edges', () => {
    expect(drive({ row: 0, col: 0 }, 'ArrowRight')).toEqual({ row: 0, col: 1 })
    expect(drive({ row: 0, col: 0 }, 'ArrowLeft')).toEqual({ row: 0, col: 0 })
    expect(drive({ row: 0, col: 0 }, 'ArrowDown')).toEqual({ row: 1, col: 0 })
    expect(drive({ row: 4, col: 0 }, 'ArrowDown')).toEqual({ row: 4, col: 0 })
    expect(drive({ row: 0, col: 3 }, 'ArrowRight')).toEqual({ row: 0, col: 3 })
  })

  it('Home/End move to the row ends; Ctrl+Home/End to the grid corners', () => {
    expect(drive({ row: 2, col: 2 }, 'Home')).toEqual({ row: 2, col: 0 })
    expect(drive({ row: 2, col: 2 }, 'End')).toEqual({ row: 2, col: 3 })
    expect(drive({ row: 2, col: 2 }, 'Home', true)).toEqual({ row: 0, col: 0 })
    expect(drive({ row: 2, col: 2 }, 'End', true)).toEqual({ row: 4, col: 3 })
  })

  it('Page Up/Down jump by pageRows, clamped', () => {
    expect(drive({ row: 0, col: 1 }, 'PageDown')).toEqual({ row: 3, col: 1 })
    expect(drive({ row: 4, col: 1 }, 'PageDown')).toEqual({ row: 4, col: 1 })
    expect(drive({ row: 1, col: 1 }, 'PageUp')).toEqual({ row: 0, col: 1 })
  })

  it('preventDefaults navigation keys and ignores everything else', () => {
    const { result } = renderHook(() => useRovingGrid(dims))
    const nav = keyEvent('ArrowDown')
    act(() => {
      result.current.onKeyDown(nav.event)
    })
    expect(nav.preventDefault).toHaveBeenCalled()
    expect(result.current.active).toEqual({ row: 1, col: 0 })

    const other = keyEvent('x')
    act(() => {
      result.current.onKeyDown(other.event)
    })
    expect(other.preventDefault).not.toHaveBeenCalled()
    expect(result.current.active).toEqual({ row: 1, col: 0 })
  })
})
