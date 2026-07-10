import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installMockIpc, stubHealthz } from './mock-ipc'

// Accessibility gate for the app shell (fast lane: chromium + mock IPC, no Tauri
// binary). Two layers: the axe engine scan (fails on ANY violation) and a
// keyboard-traversal walk over the landmark structure. The deep, per-route sweep
// lives in the opt-in gate-a11y-deep module.
// SOURCE: WCAG 2.2 AA as the shipping bar [corpus: wcag/contrast-aa]

test.beforeEach(async ({ page }) => {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await page.goto('/')
  // Deterministic settle point: the shell is interactive once the health probe
  // has resolved into the connected state.
  await expect(page.getByRole('status')).toContainText('API connected (v9.9.9)')
})

test('app shell has zero axe violations (wcag2a + wcag2aa + wcag22aa)', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze()
  // Print the full finding before failing — "violations exist" alone is undebuggable.
  for (const violation of results.violations) {
    console.error(`[axe] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`)
    for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
  }
  expect(results.violations).toEqual([])
})

test('landmarks exist, are unique, and read in order: banner → main → contentinfo', async ({
  page,
}) => {
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(1)

  const inDocumentOrder = await page.evaluate(() => {
    const header = document.querySelector('header')
    const main = document.querySelector('main')
    const footer = document.querySelector('footer')
    if (header === null || main === null || footer === null) return false
    const precedes = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    return precedes(header, main) && precedes(main, footer)
  })
  expect(inDocumentOrder).toBe(true)
})

test('keyboard traversal walks the landmarks in order without trapping', async ({ page }) => {
  // Tab through the page recording which landmark owns each focused element.
  // The scaffold shell ships no interactive controls yet, so the recorded path may
  // be empty — the assertions still prove (a) nothing focusable sits OUTSIDE a
  // landmark, (b) landmark order is banner → main → contentinfo, and (c) Tab never
  // traps (focus returns to <body> at the end of the cycle). As soon as real
  // controls exist they join this walk automatically.
  const path: string[] = []
  for (let press = 0; press < 25; press += 1) {
    await page.keyboard.press('Tab')
    const landmark = await page.evaluate(() => {
      const el = document.activeElement
      if (el === null || el === document.body) return null
      if (el.closest('header') !== null) return 'banner'
      if (el.closest('main') !== null) return 'main'
      if (el.closest('footer') !== null) return 'contentinfo'
      return 'outside'
    })
    if (landmark === null) break // wrapped back to <body> — traversal complete, no trap
    path.push(landmark)
  }

  expect(path).not.toContain('outside')

  const landmarkOrder = ['banner', 'main', 'contentinfo']
  const firstSeen = path.filter((entry, index) => path.indexOf(entry) === index)
  const indices = firstSeen.map((entry) => landmarkOrder.indexOf(entry))
  expect([...indices].sort((a, b) => a - b)).toEqual(indices)

  // No focus trap: after the walk (25 presses ≫ focusable count) the active
  // element must be back at the document root, not stuck inside a widget.
  const finished = await page.evaluate(
    () => document.activeElement === document.body || document.activeElement === null,
  )
  expect(finished).toBe(true)
})
