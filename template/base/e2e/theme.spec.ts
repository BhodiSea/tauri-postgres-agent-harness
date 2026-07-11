import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import {
  installMockIpc,
  makeNoteRows,
  setStoredTheme,
  stubDataRequests,
  stubHealthz,
  waitForMotionSettled,
} from './mock-ipc'

// Two-theme parity gate. The app ships light AND dark (src/theme/theme.ts + the
// :root[data-theme='light'] token override in styles.css); the styleguide gate
// COMPUTES WCAG contrast from the OKLCH tokens for both, and this suite proves the
// running app is clean too — every ROUTES entry is axe-swept in dark AND light.
// The LIGHT sweep is the guarantee v0.1.4 adds. The data-theme / toggle /
// persistence / system asserts are capability-gated (data-driven skip), so a
// consumer whose app predates theming still passes the sweeps and skips the rest.
// SOURCE: prefers-color-scheme is the system signal; the app persists an explicit
// override layered over it [corpus: web/prefers-color-scheme]
// SOURCE: WCAG 2.2 SC 1.4.3 contrast minimums, swept per theme [corpus: wcag/contrast-aa]

const THEMES = ['dark', 'light'] as const

// A ready NotesPage (non-empty): every current route's primary query is GET
// /api/notes, so one body settles both the home list and the matrix grid — and
// both render the first note's title, the cross-route "ready" marker below.
const READY_BODY = { items: makeNoteRows(3), nextCursor: null }
const READY_MARKER = 'Note 1'

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

/** The concrete theme the app painted onto the root element. */
function dataTheme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['theme'])
}

// Capability probe: an app that predates theming ships neither the toggle nor a
// data-theme attribute. Gate the theming asserts on the toggle so old consumers
// skip them — the axe sweeps still run against whatever single theme they paint.
async function hasTheming(page: Page): Promise<boolean> {
  return (await page.getByTestId('theme-toggle').count()) > 0
}

// Settle on the route's ready surface: the connected status proves the shell
// mounted, then the first note's title proves the query resolved into ready
// content — past the loading skeleton AND (on the lazy matrix route) past Suspense.
async function gotoReady(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('status')).toContainText('API connected')
  await expect(page.getByText(READY_MARKER, { exact: true }).first()).toBeVisible()
}

for (const route of ROUTES) {
  for (const theme of THEMES) {
    test(`${route.id} — ${theme} theme is axe-clean and paints the stored preference`, async ({
      page,
    }) => {
      await installMockIpc(page, { pinTheme: false })
      await setStoredTheme(page, theme)
      // Collapse the theme-apply colour transitions to ~instant so axe always
      // measures the resting contrast, never a mid-transition frame.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
      await stubDataRequests(page, READY_BODY)
      await gotoReady(page, route.path)

      // The parity guarantee: the same route swept for WCAG violations in BOTH
      // themes (the light sweep is new in v0.1.4). Sweep only once every
      // animation/transition has settled — axe must read resting contrast.
      await waitForMotionSettled(page)
      await expectAxeClean(page, `${route.id}:${theme}`)

      // Capability-gated: a themed app must have applied the explicit stored choice
      // (an explicit 'light'|'dark' resolves without touching prefers-color-scheme).
      if (await hasTheming(page)) {
        await expect
          .poll(() => dataTheme(page), { message: `data-theme must be ${theme}` })
          .toBe(theme)
      }
    })
  }

  test(`${route.id} — the theme toggle flips the theme and the flipped theme is axe-clean`, async ({
    page,
  }) => {
    await installMockIpc(page, { pinTheme: false })
    await setStoredTheme(page, 'light')
    await page.emulateMedia({ reducedMotion: 'reduce' }) // axe reads resting contrast, not a transition frame
    await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
    await stubDataRequests(page, READY_BODY)
    await gotoReady(page, route.path)

    test.skip(!(await hasTheming(page)), 'app has no theme toggle (pre-theming consumer)')

    // Stored 'light' → painted light; one toggle click walks light → dark, both
    // concrete so the flip does not depend on the OS colour-scheme.
    await expect.poll(() => dataTheme(page)).toBe('light')
    await page.getByTestId('theme-toggle').click()
    await expect
      .poll(() => dataTheme(page), { message: 'toggle must flip light → dark' })
      .toBe('dark')
    await waitForMotionSettled(page)
    await expectAxeClean(page, `${route.id}:toggled-dark`)
  })
}

test('a toggled theme choice persists across a reload', async ({ page }) => {
  const [home] = ROUTES
  // pinTheme:false so the reload reads the PERSISTED choice, not a re-pinned dark.
  await installMockIpc(page, { pinTheme: false })
  // System resolves to light here, so the 'dark' we toggle to is distinguishable
  // from the empty-storage default — a broken persistence layer would show light.
  await page.emulateMedia({ colorScheme: 'light' })
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubDataRequests(page, READY_BODY)
  await gotoReady(page, home.path)

  test.skip(!(await hasTheming(page)), 'app has no theme toggle (pre-theming consumer)')

  // Empty storage → `system` (→ light). Two clicks walk system → light → dark.
  const toggle = page.getByTestId('theme-toggle')
  await toggle.click()
  await toggle.click()
  await expect.poll(() => dataTheme(page)).toBe('dark')

  await page.reload()
  await expect(page.getByRole('status')).toContainText('API connected')
  await expect
    .poll(() => dataTheme(page), { message: 'the persisted dark choice must survive reload' })
    .toBe('dark')
})

test('while the preference is system, the theme tracks OS colour-scheme changes live', async ({
  page,
}) => {
  const [home] = ROUTES
  await installMockIpc(page, { pinTheme: false })
  await setStoredTheme(page, null) // clear → the `system` preference
  await page.emulateMedia({ colorScheme: 'light' })
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubDataRequests(page, READY_BODY)
  await gotoReady(page, home.path)

  test.skip(!(await hasTheming(page)), 'app has no theming (pre-theming consumer)')

  await expect
    .poll(() => dataTheme(page), { message: 'system + light scheme → light' })
    .toBe('light')
  // theme.ts subscribes to the media query while the preference is system: an OS
  // scheme flip must repaint the app with no user action.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => dataTheme(page), { message: 'system must track the OS flip to dark' })
    .toBe('dark')
})
