import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installMockIpc, stubHealthz, stubNotes } from './mock-ipc'

// Accessibility gate for the app shell (fast lane: chromium + mock IPC, no Tauri
// binary). Three layers: the axe engine scan (fails on ANY violation), a
// keyboard-traversal walk that must find a NON-EMPTY sequence of focus stops each
// with a VISIBLE focus indicator, and a modal focus-trap/restore check over the
// shortcuts overlay and command palette. The deep, per-route sweep lives in the
// opt-in gate-a11y-deep module.
// SOURCE: WCAG 2.2 AA as the shipping bar [corpus: wcag/contrast-aa]

test.beforeEach(async ({ page }) => {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubNotes(page, ['First note'])
  await page.goto('/')
  // Deterministic settle points: the health probe has resolved into the
  // connected state and the notes panel has reached its ready state.
  await expect(page.getByRole('status')).toContainText('API connected (v9.9.9)')
  await expect(page.getByText('First note')).toBeVisible()
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

interface TabStop {
  readonly landmark: string
  readonly focusIndicated: boolean
  readonly descriptor: string
}

test('keyboard traversal: non-empty, visibly-indicated focus path through the landmarks, no trap', async ({
  page,
}) => {
  // Tab through the page recording each stop's landmark AND whether focus is
  // actually VISIBLE: computed style while focused must differ from the same
  // element blurred (the shell styles :focus-visible with a 2px accent outline).
  // SOURCE: WCAG 2.2 SC 2.4.7 Focus Visible / 1.4.11 Non-text Contrast [corpus: wcag/contrast-aa]
  const path: TabStop[] = []
  for (let press = 0; press < 25; press += 1) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate((): TabStop | null => {
      const el = document.activeElement as HTMLElement | null
      if (el === null || el === document.body) return null
      const landmark =
        el.closest('header') !== null
          ? 'banner'
          : el.closest('main') !== null
            ? 'main'
            : el.closest('footer') !== null
              ? 'contentinfo'
              : 'outside'
      const indicator = (style: CSSStyleDeclaration): string =>
        [
          style.outlineStyle,
          style.outlineWidth,
          style.outlineColor,
          style.boxShadow,
          style.borderColor,
        ].join('|')
      // getComputedStyle is LIVE — snapshot the focused indicator before blurring.
      const focused = indicator(getComputedStyle(el))
      el.blur()
      const blurred = indicator(getComputedStyle(el))
      el.focus() // restore so the walk continues from this element
      return {
        landmark,
        focusIndicated: focused !== blurred,
        descriptor: `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}:${el.textContent.trim().slice(0, 24)}`,
      }
    })
    if (stop === null) break // wrapped back to <body> — traversal complete, no trap
    path.push(stop)
  }

  // ANTI-VACUITY: a page with zero tabbable elements is keyboard-inoperable —
  // the walk must fail, not pass by never asserting anything.
  expect(path.length, 'the shell must expose at least one keyboard focus stop').toBeGreaterThan(0)

  for (const stop of path) {
    expect(stop.landmark, `${stop.descriptor} must live inside a landmark`).not.toBe('outside')
    expect(
      stop.focusIndicated,
      `${stop.descriptor} shows NO visible focus indicator (outline/box-shadow/border unchanged vs blurred — WCAG 2.4.7)`,
    ).toBe(true)
  }

  const landmarkOrder = ['banner', 'main', 'contentinfo']
  const landmarks = path.map((stop) => stop.landmark)
  const firstSeen = landmarks.filter((entry, index) => landmarks.indexOf(entry) === index)
  const indices = firstSeen.map((entry) => landmarkOrder.indexOf(entry))
  expect([...indices].sort((a, b) => a - b)).toEqual(indices)

  // No focus trap: after the walk (25 presses ≫ focusable count) the active
  // element must be back at the document root, not stuck inside a widget.
  const finished = await page.evaluate(
    () => document.activeElement === document.body || document.activeElement === null,
  )
  expect(finished).toBe(true)
})

// The two modal surfaces the shell ships. Native <dialog>.showModal() provides
// the trap; this spec PROVES it instead of trusting it.
// SOURCE: WAI-ARIA APG modal dialog pattern (focus trapped while open, restored
// to the invoker on close) https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
const MODALS = [
  { combo: 'Control+/', label: 'Keyboard shortcuts' },
  { combo: 'Control+k', label: 'Command palette' },
] as const

for (const modal of MODALS) {
  test(`${modal.label} (${modal.combo}): focus is trapped while open and restored on close`, async ({
    page,
  }) => {
    // Establish a deterministic opener: blur anything focused, then Tab onto the
    // first in-page control.
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      el?.blur()
    })
    await page.keyboard.press('Tab')
    const opener = await page.evaluate(() => {
      const el = document.activeElement
      return el === null || el === document.body ? '' : `${el.tagName}:${el.textContent.trim()}`
    })
    expect(opener, 'the walk must start from a real in-page control').not.toBe('')

    await page.keyboard.press(modal.combo)
    const dialog = page.locator(`dialog[open][aria-label="${modal.label}"]`)
    await expect(dialog).toBeVisible()

    // Walk far past the dialog's own control count. The trap contract: focus may
    // sit inside the dialog or hand off to browser chrome (activeElement=body at
    // the cycle wrap — chromium's native behavior even for modal dialogs), but
    // it must NEVER land on a background element: showModal() makes the page
    // behind the dialog inert, and any 'outside' stop below disproves that.
    const stops: string[] = []
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab')
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement
          if (el === null || el === document.body) return 'chrome'
          return el.closest('dialog[open]') !== null ? 'dialog' : 'outside'
        }),
      )
    }
    expect(stops, `a background element took focus while "${modal.label}" was open`).not.toContain(
      'outside',
    )
    expect(
      stops.filter((stop) => stop === 'dialog').length,
      `the open "${modal.label}" dialog must own at least one tab stop`,
    ).toBeGreaterThan(0)

    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    const restored = await page.evaluate(() => {
      const el = document.activeElement
      return el === null || el === document.body ? '' : `${el.tagName}:${el.textContent.trim()}`
    })
    expect(restored, 'focus must return to the control that opened the dialog').toBe(opener)
  })
}
