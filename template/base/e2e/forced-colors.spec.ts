import { expect, type Locator, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, makeNoteRows, stubDataRequests, stubHealthz } from './mock-ipc'

// Windows High Contrast lock (forced-colors). The product ships WebView2-first,
// where users genuinely run forced colors: the OS flattens every background to
// Canvas and strips shadows, so any affordance carried by background color
// alone disappears. styles.css ships a `@media (forced-colors: active)` layer
// (system-color keywords only) and this spec proves the RUNNING app under
// chromium's forced-colors emulation — the same engine WebView2 embeds:
//   (a) the keyboard focus ring stays a visible outline (outlines survive
//       flattening — that is why focus is outline-based),
//   (b) Button/Input boundaries are real borders with non-transparent computed
//       colors (the ghost button's border exists ONLY via the forced-colors
//       layer; bordered controls are UA-recolored border-edge),
//   (c) matrix rows keep visible separation (the border-b separators recolor,
//       never vanish),
//   (d) the optimistic pending-note affordance survives (state by border-STYLE:
//       dashed is preserved by flattening).
// The no-preference CONTROL runs the identical border probe where a border is
// legitimately absent, proving the probe can red (the motion.spec pattern).
// Determinism: pure route interception, zero sleeps, retries:0.
// SOURCE: forced-colors media query — backgrounds flatten, borders/outlines
// persist in system colors [corpus: web/forced-colors]

const READY_BODY = { items: makeNoteRows(3), nextCursor: null }
const READY_MARKER = 'Note 1'
const MATRIX = ROUTES.find((route) => route.id === 'matrix')

// Capability gate, update-skew-safe: a pre-0.1.5 consumer's SEEDED styles.css
// has no forced-colors layer (`update` never rewrites seeded files), so these
// asserts would red through no fault of the app. Probe the LOADED stylesheets
// for the layer — top-level cssText serializes nested rules, so the @layer-
// wrapped media block is found without walking the CSSOM tree.
async function hasForcedColorsLayer(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => /forced-colors:\s*active/.test(rule.cssText))
      } catch {
        return false // cross-origin sheet — not ours
      }
    }),
  )
}

async function skipUnlessForcedColorsLayer(page: Page): Promise<void> {
  test.skip(
    !(await hasForcedColorsLayer(page)),
    'styles.css ships no forced-colors layer (pre-0.1.5 seeded styles.css) — adopt with `update --refresh-seeded apps/desktop/src/styles.css`',
  )
}

async function gotoReady(page: Page, path: string): Promise<void> {
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubDataRequests(page, READY_BODY)
  await page.goto(path)
  await expect(page.getByRole('status')).toContainText('API connected')
  await expect(page.getByText(READY_MARKER, { exact: true }).first()).toBeVisible()
}

interface EdgeProbe {
  readonly style: string
  readonly width: number
  readonly color: string
}

/** Computed border of one side — the probe both the asserts AND the control use. */
function probeBorder(locator: Locator, side: 'top' | 'bottom'): Promise<EdgeProbe> {
  return locator.evaluate((el, s) => {
    const cs = getComputedStyle(el)
    return {
      style: cs.getPropertyValue(`border-${s}-style`),
      width: Number.parseFloat(cs.getPropertyValue(`border-${s}-width`)),
      color: cs.getPropertyValue(`border-${s}-color`),
    }
  }, side)
}

const isTransparent = (color: string): boolean =>
  color === 'transparent' || color === 'rgba(0, 0, 0, 0)'

/** One shared predicate so the control genuinely mirrors the real asserts. */
const isVisibleEdge = (edge: EdgeProbe): boolean =>
  edge.style !== 'none' && edge.width > 0 && !isTransparent(edge.color)

test('forced colors: the keyboard focus ring stays a visible outline', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await installMockIpc(page)
  await gotoReady(page, '/')

  // A real keyboard walk (not programmatic focus) so :focus-visible applies.
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => {
    const el = document.activeElement
    if (el === null || el === document.body) return null
    const cs = getComputedStyle(el)
    return {
      style: cs.outlineStyle,
      width: Number.parseFloat(cs.outlineWidth),
      color: cs.outlineColor,
    }
  })
  expect(outline, 'Tab must land on a focusable element').not.toBeNull()
  expect(outline?.style, 'focus outline must survive forced colors').not.toBe('none')
  expect(outline?.width ?? 0, 'focus outline must have visible width').toBeGreaterThan(0)
  expect(isTransparent(outline?.color ?? 'transparent'), 'focus outline must paint').toBe(false)
})

test('forced colors: Button and Input boundaries are non-transparent borders', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await installMockIpc(page)
  await gotoReady(page, '/')
  await skipUnlessForcedColorsLayer(page)

  // The GHOST button (theme toggle): borderless by design in normal paint —
  // only the forced-colors layer's `button { border: thin solid ButtonText }`
  // gives it a boundary here. The control test below runs this same probe
  // without forced colors and finds nothing.
  const ghost = await probeBorder(page.getByTestId('theme-toggle'), 'top')
  expect(isVisibleEdge(ghost), `ghost button border: ${JSON.stringify(ghost)}`).toBe(true)

  // The Input primitive: its border-edge border must recolor, never flatten away.
  const input = await probeBorder(page.getByLabel('Add a note'), 'top')
  expect(isVisibleEdge(input), `input border: ${JSON.stringify(input)}`).toBe(true)
})

test('forced colors: matrix rows keep visible separation', async ({ page }) => {
  test.skip(MATRIX === undefined, 'no matrix route registered (data-driven skip)')
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await installMockIpc(page)
  await gotoReady(page, MATRIX?.path ?? '/')
  await skipUnlessForcedColorsLayer(page)

  // The first DATA row (aria-rowindex 1 is the header): its border-b separator
  // is the only gridline once backgrounds flatten, so it must stay visible.
  const grid = page.getByRole('grid', { name: 'Notes matrix' })
  await expect(grid).toBeVisible()
  const row = await probeBorder(grid.locator('[role="row"][aria-rowindex="2"]'), 'bottom')
  expect(isVisibleEdge(row), `row separator: ${JSON.stringify(row)}`).toBe(true)
})

test('forced colors: the pending optimistic row keeps its dashed affordance', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })

  // mutation.spec's held-POST pattern: GETs serve a ready page, OPTIONS answers
  // the CORS preflight, and the POST never resolves — pinning the optimistic
  // window open so the pending row is deterministically on screen.
  await page.route(
    (url: URL) => url.port === '8787' && !url.pathname.endsWith('/healthz'),
    async (route) => {
      const method = route.request().method()
      if (method === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type',
            'access-control-allow-methods': 'GET,POST',
          },
        })
        return
      }
      if (method === 'POST') {
        // Held open for the whole test (the holdDataRequests precedent: the
        // context closing is the release) — the pending row can never reconcile
        // or roll back underneath the asserts.
        await new Promise(() => undefined)
        return
      }
      await route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify(READY_BODY),
      })
    },
  )
  await page.goto('/')
  await expect(page.getByText(READY_MARKER, { exact: true }).first()).toBeVisible()
  await skipUnlessForcedColorsLayer(page)

  await page.getByLabel('Add a note').fill('Forced colors pending note')
  await page.getByRole('button', { name: 'Add note' }).click()

  // State communicated by border-STYLE survives flattening: the pending row's
  // dashed edge must compute dashed AND paint (recolored, not stripped).
  const pendingRow = page.locator('li[data-pending="true"]')
  await expect(pendingRow).toBeVisible()
  const edge = await probeBorder(pendingRow, 'top')
  expect(edge.style, 'the pending affordance is the dashed border style').toBe('dashed')
  expect(edge.width, 'the dashed edge must have width').toBeGreaterThan(0)
  expect(isTransparent(edge.color), 'the dashed edge must paint').toBe(false)
})

test('control: WITHOUT forced colors the same probe finds NO border on the ghost button', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' })
  await installMockIpc(page)
  await gotoReady(page, '/')

  // Falsifiability: the identical probe + predicate as the forced-colors button
  // assert, against the same element — which legitimately has no border in
  // normal paint. If this reported a visible edge, the real assert could never
  // red; a 'true' up there is therefore the forced-colors layer's doing.
  const ghost = await probeBorder(page.getByTestId('theme-toggle'), 'top')
  expect(isVisibleEdge(ghost), `ghost button must be borderless: ${JSON.stringify(ghost)}`).toBe(
    false,
  )
})
