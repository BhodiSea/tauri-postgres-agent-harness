import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, makeNoteRows, stubHealthz } from './mock-ipc'

// Reflow closure (WCAG 2.2 SC 1.4.10): the Tauri window can be dragged down to its
// declared minimum, and at that size no screen may force horizontal scrolling of the
// document — content reflows into the narrower column instead of spilling off-screen
// behind a scrollbar. The app resizes to 640×480, yet nothing exercised it: a fixed
// min-width panel or an un-wrapping row would ship a horizontally-scrolling desktop and
// every gate stayed green.
//
// The viewport is READ FROM tauri.conf.json (minWidth/minHeight), not hard-coded here, so
// this lane can never drift from the window the shell actually allows.
// SOURCE: WCAG 2.2 SC 1.4.10 Reflow — no loss of content/function, no 2-D scroll at the
// target viewport https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
// SOURCE: harness doctrine — the states/a11y closure iterates ROUTES [corpus: harness/doctrine]

// The e2e project compiles with types:[] (Playwright transpiles specs itself); the ONE
// node builtin it touches is declared in e2e/node-fs.d.ts, mirroring interaction-latency.
interface TauriWindow {
  readonly minWidth?: number
  readonly minHeight?: number
}
interface TauriConf {
  readonly app?: { readonly windows?: readonly TauriWindow[] }
}

// Resolve the minimum window from the committed Tauri config. A missing/zero minimum is a
// FAIL, not a silent skip: this lane must never pass by measuring a window the app forbids.
function tauriMinViewport(): { width: number; height: number } {
  const raw = readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')
  const conf = JSON.parse(raw) as TauriConf
  const win = conf.app?.windows?.[0]
  const width = win?.minWidth ?? 0
  const height = win?.minHeight ?? 0
  if (width <= 0 || height <= 0) {
    throw new Error(
      `tauri.conf.json declares no positive window minWidth/minHeight (got ${String(width)}×${String(height)}) — the reflow lane cannot choose a viewport`,
    )
  }
  return { width, height }
}

const MIN = tauriMinViewport()

async function expectAxeClean(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze()
  for (const violation of results.violations) {
    console.error(
      `[axe:${context}] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
    )
    for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
  }
  expect(results.violations, context).toEqual([])
}

test('the ROUTES manifest is non-empty (else this reflow suite is a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

for (const route of ROUTES) {
  test(`reflow: ${route.id} (${route.path}) has no horizontal document scroll at ${String(MIN.width)}×${String(MIN.height)}`, async ({
    page,
  }) => {
    await page.setViewportSize(MIN)
    await installMockIpc(page)
    await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
    // Answer every data request with a full page of rows: the dense, most-likely-to-overflow
    // state (a long list, a wide grid) is exactly what reflow must survive.
    await page.route(
      (url) => url.port === '8787' && !url.pathname.endsWith('/healthz'),
      async (dataRoute) => {
        await dataRoute.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': '*' },
          contentType: 'application/json',
          body: JSON.stringify({ items: makeNoteRows(50), nextCursor: null }),
        })
      },
    )
    await page.goto(route.path)
    await expect(page.getByRole('status')).toContainText('API connected (v9.9.9)')

    // The document must not scroll horizontally: scrollWidth may exceed the viewport by at
    // most a sub-pixel rounding margin. A real overflow (a fixed-width panel, a non-wrapping
    // row) blows past this by tens of pixels.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
    })
    expect(
      overflow.scrollWidth,
      `${route.id} scrolls horizontally at the minimum window (${String(overflow.scrollWidth)}px content in a ${String(overflow.clientWidth)}px viewport) — content must reflow, not spill behind a scrollbar (WCAG 1.4.10)`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1)

    // Small viewports routinely expose overlap/contrast/target issues the wide layout hid.
    await expectAxeClean(page, `reflow:${route.id}`)
  })
}
