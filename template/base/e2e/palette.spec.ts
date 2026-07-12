import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  installMockIpc,
  makeNoteRows,
  setStoredTheme,
  stubDataRequests,
  stubHealthz,
  waitForMotionSettled,
} from './mock-ipc'

// The command-palette lock (features/palette): deterministic fuzzy ranking,
// grouped sections, subtitle/keys hints, localStorage recents, and contextual
// screen contributions — driven KEYBOARD-ONLY (mod+k in, arrows + Enter
// through, Escape out; not a single mouse click), with zero sleeps. The pinned
// ranking assertions mirror fuzzyScore.test.ts exactly: 'tm' scores two
// word-boundary hits in "Go to Matrix" above every scattered match, and the
// score → title → id tie-break makes the full order deterministic.
// Capability-gated like matrix.spec: a consumer whose palette predates grouped
// ranking (pre-0.1.5 seeded CommandPalette) skips instead of failing.
// SOURCE: WAI-ARIA APG combobox pattern (listbox popup) — aria-activedescendant
// tracks the active option while focus stays in the input
// https://www.w3.org/WAI/ARIA/apg/patterns/combobox/

const READY_BODY = { items: makeNoteRows(3), nextCursor: null }

async function gotoReady(page: Page, path: string): Promise<void> {
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubDataRequests(page, READY_BODY)
  await page.goto(path)
  await expect(page.getByRole('status')).toContainText('API connected')
  await expect(page.getByText('Note 1', { exact: true }).first()).toBeVisible()
}

/** Open the palette via its registered shortcut. The dialog becoming visible
 *  implies AppDialog's open effect ran — which also hands focus to the
 *  data-autofocus input — so typing right after is deterministic. */
async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  await expect(page.locator('dialog[open][aria-label="Command palette"]')).toBeVisible()
}

/** Skip on a pre-grouped-palette consumer (options directly under the listbox). */
async function skipUnlessGrouped(page: Page): Promise<void> {
  const groups = await page.locator('#command-palette-options [role="group"]').count()
  test.skip(groups === 0, 'palette predates grouped ranking (pre-0.1.5 seeded CommandPalette)')
}

const optionTitles = (page: Page) =>
  page.locator('#command-palette-options [role="option"] > span:first-child')

const groupHeaders = (page: Page) =>
  page.locator('#command-palette-options [role="group"] > [role="presentation"]')

test('typing ranks and regroups: "tm" pins Go to Matrix first; sections follow their best member', async ({
  page,
}) => {
  await installMockIpc(page)
  await gotoReady(page, '/')
  await openPalette(page)
  await skipUnlessGrouped(page)

  // Keyboard-first contract: the combobox input owns focus on open (the
  // data-autofocus seam in AppDialog) — typing never needs a click.
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused()
  await page.keyboard.type('tm')
  // The pinned order from fuzzyScore.test.ts, regrouped: Navigation ranks
  // first because its best member (Go to Matrix) outscores everything.
  await expect(optionTitles(page)).toHaveText([
    'Go to Matrix',
    'Go to Home',
    'Use dark theme',
    'Use light theme',
  ])
  await expect(groupHeaders(page)).toHaveText(['Navigation', 'Theme'])
})

test('options carry right-aligned hints: the registry-derived key combo and the route subtitle', async ({
  page,
}) => {
  await installMockIpc(page)
  await gotoReady(page, '/')
  await openPalette(page)
  await skipUnlessGrouped(page)

  // keys hint: derived from SHORTCUTS in src/keyboard/registry.ts, so it
  // matches the footer hint for the same shortcut character-for-character.
  const shortcuts = page.getByRole('option', { name: /Show keyboard shortcuts/ })
  const combo = await page
    .locator('footer li', { hasText: 'Keyboard shortcuts' })
    .locator('kbd')
    .innerText()
  await expect(shortcuts.locator('kbd')).toHaveText(combo)
  // subtitle hint: the navigation command names its route path.
  await expect(
    page
      .getByRole('option', { name: /Go to Matrix/ })
      .locator('span')
      .last(),
  ).toHaveText('/matrix')
})

test('ArrowDown walks the flat ranked list across a section boundary and Enter runs the command', async ({
  page,
}) => {
  await installMockIpc(page)
  await gotoReady(page, '/')
  await openPalette(page)
  await skipUnlessGrouped(page)

  await page.keyboard.type('tm')
  const input = page.getByRole('combobox', { name: 'Search commands' })
  await expect(input).toHaveAttribute('aria-activedescendant', 'palette-option-0')
  // Three ArrowDowns: Go to Matrix → Go to Home (still Navigation) → Use dark
  // theme (crosses into Theme) → Use light theme.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', 'palette-option-3')
  await page.keyboard.press('Enter')
  // The command ran for real: the palette closed and the theme flipped to
  // light (the mock pins the stored preference to dark before load).
  await expect(page.locator('dialog[open][aria-label="Command palette"]')).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['theme']))
    .toBe('light')
})

test('recents: a run command pins under Recents on the empty query and survives a reload', async ({
  page,
}) => {
  await installMockIpc(page)
  await gotoReady(page, '/')
  await openPalette(page)
  await skipUnlessGrouped(page)

  // Run "Go to Matrix" through the palette (best match stays active at 0).
  await page.keyboard.type('matrix')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/matrix$/)

  // Reopen: the empty query pins Recents first, the run command on top.
  await openPalette(page)
  await expect(groupHeaders(page).first()).toHaveText('Recents')
  await expect(optionTitles(page).first()).toHaveText('Go to Matrix')
  await page.keyboard.press('Escape')

  // localStorage persistence: the pin survives a full reload.
  await page.reload()
  await expect(page.getByRole('status')).toContainText('API connected')
  await openPalette(page)
  await expect(groupHeaders(page).first()).toHaveText('Recents')
  await expect(optionTitles(page).first()).toHaveText('Go to Matrix')
})

test('the matrix screen contributes contextual commands; Jump to top focuses the first cell; leaving withdraws them', async ({
  page,
}) => {
  await installMockIpc(page)
  await gotoReady(page, '/matrix')
  await expect(page.getByRole('grid')).toBeVisible()
  await openPalette(page)
  await skipUnlessGrouped(page)

  // Registered while the screen is mounted, grouped under its own section.
  await expect(page.getByRole('group', { name: 'Matrix' })).toBeVisible()
  await expect(page.getByRole('option', { name: /Reload matrix rows/ })).toBeVisible()

  // Jump to top is REAL: it drives the grid's follow-focus seam — the palette
  // closes and the roving focus lands on the first cell.
  await page.keyboard.type('jump')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-row="0"][data-col="0"]')).toBeFocused()

  // Navigate away (keyboard, through the palette) — the contribution is gone.
  await openPalette(page)
  await page.keyboard.type('home')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/$/)
  await openPalette(page)
  await expect(page.getByRole('option', { name: /Jump to top/ })).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`palette open state (grouped, with recents) is axe-clean in the ${theme} theme`, async ({
    page,
  }) => {
    await installMockIpc(page, { pinTheme: false })
    await setStoredTheme(page, theme)
    // axe must read resting contrast, never a mid-transition frame.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoReady(page, '/')
    await openPalette(page)
    await skipUnlessGrouped(page)

    // Sweep with a Recents section present (the busiest palette surface):
    // seed one recent id the way recents.ts persists it, then reopen.
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      localStorage.setItem('palette.recents', JSON.stringify(['theme.dark']))
    })
    await page.reload()
    await expect(page.getByRole('status')).toContainText('API connected')
    await openPalette(page)
    await expect(groupHeaders(page).first()).toHaveText('Recents')

    await waitForMotionSettled(page)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze()
    for (const violation of results.violations) {
      console.error(
        `[axe:palette:${theme}] ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
      )
      for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
    }
    expect(results.violations, `palette:${theme}`).toEqual([])
  })
}
