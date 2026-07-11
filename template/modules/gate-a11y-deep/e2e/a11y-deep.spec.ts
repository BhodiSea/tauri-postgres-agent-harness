import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, stubHealthz } from './mock-ipc'

// Deep accessibility sweep (gate-a11y-deep module): the FULL axe tag set — WCAG
// 2.0/2.1 A+AA plus the 2.2 additions — and a strict keyboard-traversal walk,
// across every route in the canonical manifest (apps/desktop/src/routes.ts —
// the same ROUTES the route-manifest gate closes over, so a screen cannot be
// registered without joining this sweep). The fast lane (a11y.spec.ts) guards
// the shell per-PR; this sweep guards the whole route surface.
// Machine checks end where judgement begins: docs/nvda-checklist.md holds the
// manual screen-reader pass this sweep cannot replace.
// SOURCE: WCAG 2.2 AA as the shipping bar [corpus: wcag/contrast-aa]

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

// The walk hard-stops here; a page with more real tab stops than this is a
// data-list that must manage focus (roving tabindex), not a longer walk.
const MAX_PRESSES = 100

test('the route manifest is not empty (an empty sweep is a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

interface TabStop {
  readonly landmark: string
  readonly visible: boolean
  readonly labeled: boolean
  readonly descriptor: string
  /**
   * 'none' = new element; 'first' = wrapped back to the first stop (cycle
   * complete); 'stuck' = focus did not move ("focus stopped moving" is the
   * tightest trap of all, and it must never read as a completed wrap);
   * 'other' = jumped back mid-cycle — a trap over a subset of controls.
   */
  readonly revisit: 'none' | 'first' | 'stuck' | 'other'
}

// Runs IN THE PAGE via page.evaluate — must stay closure-free (playwright
// serializes the function source). Tracks visited elements on window so a
// revisit is distinguishable from progress.
function snapshotTabStop(): TabStop | null {
  const el = document.activeElement
  if (el === null || el === document.body) return null
  const walk = window as unknown as { __a11yVisited?: Element[] }
  walk.__a11yVisited ??= []
  const seenAt = walk.__a11yVisited.indexOf(el)
  const revisit =
    seenAt === -1
      ? 'none'
      : seenAt === walk.__a11yVisited.length - 1
        ? 'stuck'
        : seenAt === 0
          ? 'first'
          : 'other'
  if (seenAt === -1) walk.__a11yVisited.push(el)
  const rect = el.getBoundingClientRect()
  const text = el.textContent.trim()
  const label = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? ''
  const title = el.getAttribute('title') ?? ''
  let landmark = 'outside'
  for (const [selector, role] of [
    ['header', 'banner'],
    ['main', 'main'],
    ['footer', 'contentinfo'],
    ['nav', 'navigation'],
  ] as const) {
    if (el.closest(selector) !== null) {
      landmark = role
      break
    }
  }
  return {
    landmark,
    visible: rect.width > 0 && rect.height > 0,
    labeled: text.length > 0 || label.length > 0 || title.length > 0,
    descriptor: `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}`,
    revisit,
  }
}

for (const route of ROUTES) {
  test.describe(`route: ${route.id} (${route.path})`, () => {
    test.beforeEach(async ({ page }) => {
      await installMockIpc(page)
      await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
      // Every non-healthz API request answers an empty page (@app/schema list
      // contract) — the sweep audits each screen's EMPTY state, which must be
      // as accessible as its ready state.
      await page.route(
        (url) => url.port === '8787' && !url.pathname.endsWith('/healthz'),
        async (dataRoute) => {
          await dataRoute.fulfill({
            status: 200,
            headers: { 'access-control-allow-origin': '*' },
            contentType: 'application/json',
            body: '{"items":[],"nextCursor":null}',
          })
        },
      )
      await page.goto(route.path)
      await expect(page.getByRole('main')).toBeVisible()
    })

    test('zero axe violations across the full WCAG 2.x tag set', async ({ page }) => {
      const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()
      for (const violation of results.violations) {
        console.error(
          `[axe:${route.id}] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
        )
        for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
      }
      expect(results.violations).toEqual([])
    })

    test('keyboard traversal: non-empty walk, every stop visible/labeled/in a landmark, cycle terminates', async ({
      page,
    }) => {
      // The walk tracks VISITED elements in-page. Termination means the cycle
      // returned to <body> (chromium hands focus back to the document) or
      // wrapped to the FIRST stop. Revisiting any OTHER element first is a
      // focus trap, and "focus stopped moving" (the same element absorbing
      // every Tab) is the tightest trap of all — both fail loudly here, where
      // the pre-fix walk silently exhausted its press budget and passed.
      const stops: TabStop[] = []
      let terminated = false
      for (let press = 0; press < MAX_PRESSES; press += 1) {
        await page.keyboard.press('Tab')
        const stop = await page.evaluate(snapshotTabStop)
        if (stop === null || stop.revisit === 'first') {
          terminated = true // full cycle: back to <body> or wrapped to the first stop
          break
        }
        expect(
          stop.revisit,
          `focus TRAP at ${stop.descriptor}: ${
            stop.revisit === 'stuck'
              ? 'focus did not move on Tab'
              : 'Tab revisited it before the cycle completed'
          }`,
        ).toBe('none')
        stops.push(stop)
      }

      expect(
        terminated,
        `Tab never completed a cycle within ${String(MAX_PRESSES)} presses — focus is trapped`,
      ).toBe(true)
      // ANTI-VACUITY: a route with zero tab stops is keyboard-inoperable.
      expect(
        stops.length,
        `route ${route.id} must expose at least one keyboard focus stop`,
      ).toBeGreaterThan(0)

      for (const stop of stops) {
        expect(stop.landmark, `${stop.descriptor} must live inside a landmark`).not.toBe('outside')
        expect(stop.visible, `${stop.descriptor} must be visible when focused`).toBe(true)
        expect(stop.labeled, `${stop.descriptor} must have an accessible name`).toBe(true)
      }

      // Landmark reading order: first occurrences must respect banner → main → contentinfo.
      const order = ['banner', 'navigation', 'main', 'contentinfo']
      const firstSeen = stops
        .map((s) => s.landmark)
        .filter((landmark, index, all) => all.indexOf(landmark) === index)
      const indices = firstSeen.map((landmark) => order.indexOf(landmark))
      expect([...indices].sort((a, b) => a - b)).toEqual(indices)
    })
  })
}
