import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import {
  installMockIpc,
  makeNoteRows,
  stubHealthz,
  stubNotesPages,
  waitForMotionSettled,
} from './mock-ipc'

// The data-dense exemplar: a virtualized, APG roving-tabindex grid over
// keyset-paginated data. This suite proves the four claims that make it a
// reference subject — the grid is ONE tab stop (roving tabindex); the arrow keys
// move the focused cell and it shows a visible focus ring; the rendered window is
// far smaller than the true row count (virtualization is real); and Load-more
// forwards the keyset cursor — then axe-sweeps the ready grid. Data-driven skip
// keeps a consumer without a matrix route green.
// SOURCE: WAI-ARIA APG grid pattern — single tab stop, roving arrow navigation,
// aria-rowcount reported over a virtualized window [corpus: wai-aria/apg-grid]

const MATRIX = ROUTES.find((route) => route.id === 'matrix')

// Distinctive token so the Load-more request assertion is unambiguous.
const PAGE_TWO_CURSOR = 'cursor-token-page-2'
const PAGE_ONE_ROWS = 200 // >> the viewport window, so virtualization is unmistakable
const PAGE_TWO_ROWS = 50

/** Is focus currently inside the grid? */
function focusInGrid(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement
    return el !== null && el !== document.body && el.closest('[role="grid"]') !== null
  })
}

/** The active cell's grid coordinates (data-row/data-col on the focused cell). */
function activeCell(page: Page): Promise<{ readonly row: number; readonly col: number } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    const row = el?.getAttribute('data-row')
    const col = el?.getAttribute('data-col')
    if (row === null || row === undefined || col === null || col === undefined) return null
    return { row: Number(row), col: Number(col) }
  })
}

/** Tab until focus enters the grid (or give up after a bounded walk). */
async function tabIntoGrid(page: Page): Promise<boolean> {
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab')
    if (await focusInGrid(page)) return true
  }
  return false
}

async function gotoReadyGrid(page: Page, path: string): Promise<void> {
  await installMockIpc(page)
  // Collapse theme-apply colour transitions to ~instant, so the ready-grid axe
  // sweep reads resting contrast, not a mid-transition frame.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubNotesPages(page, [
    { items: makeNoteRows(PAGE_ONE_ROWS), nextCursor: PAGE_TWO_CURSOR },
    { items: makeNoteRows(PAGE_TWO_ROWS, PAGE_ONE_ROWS), nextCursor: null },
  ])
  await page.goto(path)
  await expect(page.getByRole('grid')).toBeVisible()
}

if (MATRIX === undefined) {
  test('matrix route (skipped: not registered in this consumer)', () => {
    test.skip(true, 'ROUTES has no "matrix" entry — the app does not ship the grid exemplar')
  })
} else {
  const matrix = MATRIX

  test('the grid is a single tab stop (roving tabindex)', async ({ page }) => {
    await gotoReadyGrid(page, matrix.path)

    // A roving-tabindex grid exposes exactly ONE tabbable cell: Tab enters the
    // grid once and the next Tab leaves it. Walk the tab order and count how many
    // consecutive stops land inside the grid.
    let entered = false
    let insideCount = 0
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab')
      if (await focusInGrid(page)) {
        insideCount += 1
        entered = true
      } else if (entered) {
        break // stepped past the grid — traversal through it is complete
      }
    }
    expect(entered, 'Tab never reached the grid').toBe(true)
    expect(insideCount, 'a roving-tabindex grid must be exactly one tab stop').toBe(1)
  })

  test('arrow keys move the focused cell, which shows a visible focus indicator', async ({
    page,
  }) => {
    await gotoReadyGrid(page, matrix.path)

    // Focus lands on the active cell (row 0, col 0) after tabbing in.
    expect(await tabIntoGrid(page), 'focus must reach the grid').toBe(true)
    const start = await activeCell(page)
    expect(start, 'focus must be on a grid cell after tabbing in').not.toBeNull()

    // The grid owns onKeyDown and re-focuses the newly-active cell: ArrowRight
    // advances the column, ArrowDown advances the row.
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(async () => (await activeCell(page))?.col, {
        message: 'ArrowRight must advance the focused cell one column',
      })
      .toBe((start?.col ?? 0) + 1)

    await page.keyboard.press('ArrowDown')
    await expect
      .poll(async () => (await activeCell(page))?.row, {
        message: 'ArrowDown must advance the focused cell one row',
      })
      .toBe((start?.row ?? 0) + 1)

    // Visible focus indicator (WCAG 2.4.7): computed style while focused must
    // differ from the same cell blurred (the shell styles :focus-visible with a
    // 2px accent outline). Same computed-style delta as a11y.spec's keyboard walk.
    const focusIndicated = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (el === null) return false
      const indicator = (style: CSSStyleDeclaration): string =>
        [
          style.outlineStyle,
          style.outlineWidth,
          style.outlineColor,
          style.boxShadow,
          style.borderColor,
        ].join('|')
      const focused = indicator(getComputedStyle(el))
      el.blur()
      const blurred = indicator(getComputedStyle(el))
      el.focus() // restore
      return focused !== blurred
    })
    expect(
      focusIndicated,
      'the focused cell shows no visible focus indicator (outline unchanged vs blurred — WCAG 2.4.7)',
    ).toBe(true)
  })

  test('virtualization: rendered rows are far fewer than the true row count', async ({ page }) => {
    await gotoReadyGrid(page, matrix.path)

    const grid = page.getByRole('grid')
    // aria-rowcount is the TRUE size (data rows + header row); page 1 alone is 200.
    const rowCount = Number(await grid.getAttribute('aria-rowcount'))
    expect(
      rowCount,
      'the grid must report the full row count to assistive tech via aria-rowcount',
    ).toBeGreaterThan(100)

    const renderedRows = await page.locator('[role="row"]').count()
    expect(renderedRows, 'the window must render some rows').toBeGreaterThan(0)
    // A real virtual window renders only the viewport slice, not the whole list.
    expect(
      renderedRows,
      `virtualization is not windowing: ${String(renderedRows)} of ${String(rowCount)} rows are in the DOM`,
    ).toBeLessThan(rowCount / 2)
  })

  test('Load more appends the next page and forwards the keyset cursor', async ({ page }) => {
    await gotoReadyGrid(page, matrix.path)

    const grid = page.getByRole('grid')
    expect(Number(await grid.getAttribute('aria-rowcount'))).toBe(PAGE_ONE_ROWS + 1) // + header

    // Only the page-2 request carries a cursor (page 1 has none); capture it.
    const pageTwoRequest = page.waitForRequest((request) => request.url().includes('cursor='))
    await page.getByRole('button', { name: 'Load more' }).click()

    const requested = new URL((await pageTwoRequest).url())
    expect(
      requested.searchParams.get('cursor'),
      'Load more must forward page 1 nextCursor as the keyset cursor',
    ).toBe(PAGE_TWO_CURSOR)

    // Page 2 appended: the true row count grows and the exhausted list hides Load more.
    await expect(grid).toHaveAttribute('aria-rowcount', String(PAGE_ONE_ROWS + PAGE_TWO_ROWS + 1))
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  })

  test('the ready grid is axe-clean (wcag2a + wcag2aa + wcag22aa)', async ({ page }) => {
    await gotoReadyGrid(page, matrix.path)
    await waitForMotionSettled(page)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze()
    for (const violation of results.violations) {
      console.error(
        `[axe:matrix] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
      )
      for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
    }
    expect(results.violations).toEqual([])
  })
}
