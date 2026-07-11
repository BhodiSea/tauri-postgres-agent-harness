import { type RefObject, useEffect, useState } from 'react'

// Hand-rolled row virtualization: a PURE windowing calculation plus a
// rAF-throttled scroll subscription. No @tanstack/react-virtual — the math is a
// dozen lines, unit-testable in isolation, and keeps the supply chain and the
// React-Compiler story simple.

// Unitless: the grid pairs this with a matching row-height utility class (see
// MatrixGrid). 36 == Tailwind h-9 (2.25rem at the default root font size).
export const ROW_HEIGHT = 36

export interface VirtualWindowInput {
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly rowHeight: number
  readonly rowCount: number
  /** Extra rows rendered above/below the viewport to cover fast scrolls. */
  readonly overscan: number
}

export interface VirtualWindow {
  /** First rendered row index (inclusive). */
  readonly start: number
  /** One past the last rendered row index (exclusive). */
  readonly end: number
  /** Pixel offset of the first rendered row from the top of the scroll area. */
  readonly offsetY: number
  /** Full scrollable height for all rows. */
  readonly totalHeight: number
}

/** Pure: given scroll geometry, which row slice to render and where to place it. */
export function computeWindow(input: VirtualWindowInput): VirtualWindow {
  const { scrollTop, viewportHeight, rowHeight, rowCount, overscan } = input
  const totalHeight = rowCount * rowHeight
  if (rowCount <= 0 || viewportHeight <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: Math.max(0, totalHeight) }
  }
  const clampedTop = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - viewportHeight))
  const firstVisible = Math.floor(clampedTop / rowHeight)
  const start = Math.max(0, firstVisible - overscan)
  const visibleCount = Math.ceil(viewportHeight / rowHeight)
  const end = Math.min(rowCount, firstVisible + visibleCount + overscan + 1)
  return { start, end, offsetY: start * rowHeight, totalHeight }
}

/**
 * Subscribe to a scroll container's scrollTop, throttled to one update per
 * animation frame so a fast scroll never floods React with state updates.
 */
export function useScrollTop(ref: RefObject<HTMLElement | null>): number {
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return undefined
    let frame = 0
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScrollTop(element.scrollTop)
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [ref])
  return scrollTop
}
