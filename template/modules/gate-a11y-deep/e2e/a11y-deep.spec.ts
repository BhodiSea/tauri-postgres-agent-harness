import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { ROUTES } from './a11y-routes'
import { installMockIpc, stubHealthz } from './mock-ipc'

// Deep accessibility sweep (gate-a11y-deep module): the FULL axe tag set — WCAG
// 2.0/2.1 A+AA plus the 2.2 additions — and a keyboard-traversal walk, across
// every route in e2e/a11y-routes.ts. The fast lane (a11y.spec.ts) guards the
// shell per-PR; this sweep guards the whole route surface.
// Machine checks end where judgement begins: docs/nvda-checklist.md holds the
// manual screen-reader pass this sweep cannot replace.
// SOURCE: WCAG 2.2 AA as the shipping bar [corpus: wcag/contrast-aa]

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

test('the route manifest is not empty (an empty sweep is a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

for (const route of ROUTES) {
  test.describe(`route: ${route.name} (${route.path})`, () => {
    test.beforeEach(async ({ page }) => {
      await installMockIpc(page)
      await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
      await page.goto(route.path)
      await expect(page.getByRole('main')).toBeVisible()
    })

    test('zero axe violations across the full WCAG 2.x tag set', async ({ page }) => {
      const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()
      for (const violation of results.violations) {
        console.error(
          `[axe:${route.name}] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
        )
        for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
      }
      expect(results.violations).toEqual([])
    })

    test('keyboard traversal: every tab stop is visible, labeled, and inside a landmark', async ({
      page,
    }) => {
      interface TabStop {
        readonly landmark: string
        readonly visible: boolean
        readonly labeled: boolean
        readonly descriptor: string
      }
      const stops: TabStop[] = []
      for (let press = 0; press < 50; press += 1) {
        await page.keyboard.press('Tab')
        const stop = await page.evaluate((): TabStop | null => {
          const el = document.activeElement
          if (el === null || el === document.body) return null
          const rect = el.getBoundingClientRect()
          const text = el.textContent.trim()
          const label = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? ''
          const title = el.getAttribute('title') ?? ''
          const landmark =
            el.closest('header') !== null
              ? 'banner'
              : el.closest('main') !== null
                ? 'main'
                : el.closest('footer') !== null
                  ? 'contentinfo'
                  : el.closest('nav') !== null
                    ? 'navigation'
                    : 'outside'
          return {
            landmark,
            visible: rect.width > 0 && rect.height > 0,
            labeled: text.length > 0 || label.length > 0 || title.length > 0,
            descriptor: `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}`,
          }
        })
        if (stop === null) break // wrapped back to <body> — cycle complete, no trap
        stops.push(stop)
      }

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
