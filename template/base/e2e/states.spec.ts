import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, stubHealthz } from './mock-ipc'

// States closure: every ROUTES entry (apps/desktop/src/routes.ts) must actually
// RENDER each state it declares. The API origin is stubbed by BEHAVIOR CLASS, not
// per endpoint — hold every data response (loading), answer [] (empty), answer
// 500 (error) — so a future route's data endpoints are covered by the same three
// drivers. Each state is axe-scanned too: a loading or error screen is still a
// screen, and the error state must carry a retry affordance that works.
// SOURCE: harness doctrine — degraded/empty/loading states are a first-class UI
// concern [corpus: harness/doctrine]

// Deterministic settle point shared with a11y.spec.ts.
const CONNECTED = 'API connected (v9.9.9)'

// The fast lane's stub API origin (playwright.config.ts webServer env). /healthz
// belongs to the connection probe (stubbed separately); every OTHER request on
// this origin is a data request owned by the state drivers below.
const isDataRequest = (url: URL): boolean =>
  url.port === '8787' && !url.pathname.endsWith('/healthz')

const CORS_HEADERS = { 'access-control-allow-origin': '*' } as const

const fulfillJson = { status: 200, headers: CORS_HEADERS, contentType: 'application/json' }

// The scaffold's list contract (@app/schema NotesPage): a page of items plus
// the keyset cursor. "Zero items" for any list endpoint is an empty page.
const EMPTY_PAGE = '{"items":[],"nextCursor":null}'
// Errors are the envelope contract: { error: { code, message } }.
const ERROR_BODY = '{"error":{"code":"internal","message":"boom"}}'

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

test('the ROUTES manifest is non-empty (an empty manifest makes this suite a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

for (const route of ROUTES) {
  test.describe(`route: ${route.id} (${route.path})`, () => {
    test.beforeEach(async ({ page }) => {
      await installMockIpc(page)
      await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
    })

    test('loading state renders (and is axe-clean) while the query is in flight', async ({
      page,
    }) => {
      // Hold every data response until released — the loading surface must be
      // what the user sees for the ENTIRE in-flight window, not a flicker.
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(isDataRequest, async (dataRoute) => {
        await gate
        await dataRoute.fulfill({ ...fulfillJson, body: EMPTY_PAGE })
      })
      await page.goto(route.path)
      const loadingEl = page.getByTestId(route.states.loading)
      await expect(loadingEl).toBeVisible()

      // QUALITY, not just existence (G20): the loading surface must be a real Skeleton —
      // it ANNOUNCES itself to assistive tech (a bare spinner is silent) and renders
      // placeholder bars. A route that shipped `<div data-testid="x-loading">Loading</div>`
      // used to satisfy the manifest and this spec; now it reds.
      const loadInfo = await loadingEl.evaluate((root) => ({
        text: root.textContent.trim().toLowerCase(),
        bars: root.querySelectorAll('[aria-hidden="true"]').length,
      }))
      expect(
        loadInfo.text,
        'the loading state must announce itself to assistive tech (the Skeleton sr-only string) — a silent spinner leaves a screen-reader user guessing',
      ).toContain('loading')
      expect(
        loadInfo.bars,
        'the loading state renders placeholder bars (the Skeleton primitive), not a bare word',
      ).toBeGreaterThan(0)

      await expectAxeClean(page, `${route.id}:loading`)
      // Releasing the held response must advance the screen out of loading.
      release()
      await expect(page.getByTestId(route.states.empty)).toBeVisible()
    })

    test('empty state renders (and is axe-clean) when the query returns zero items', async ({
      page,
    }) => {
      await page.route(isDataRequest, async (dataRoute) => {
        await dataRoute.fulfill({ ...fulfillJson, body: EMPTY_PAGE })
      })
      await page.goto(route.path)
      const emptyEl = page.getByTestId(route.states.empty)
      await expect(emptyEl).toBeVisible()

      // QUALITY, not just existence (G20): an empty state is a title AND a supporting
      // description (the EmptyState primitive), never a bare "None". A route that shipped
      // `<div data-testid="x-empty">Empty</div>` cleared the manifest and the old
      // visible-check; now the structure is asserted against the real render.
      const emptyInfo = await emptyEl.evaluate((root) => {
        const leaves = Array.from(root.querySelectorAll('*')).filter(
          (el) => el.children.length === 0 && el.textContent.trim() !== '',
        )
        // A bare `<div>None</div>` has no element children — fall back to its own text so
        // it still counts as exactly one run (and fails the ≥2 check below).
        const runs =
          leaves.length > 0
            ? leaves.map((el) => el.textContent.trim())
            : [root.textContent.trim()].filter((t) => t !== '')
        return { runs, maxWords: Math.max(0, ...runs.map((r) => r.split(/\s+/).length)) }
      })
      expect(
        emptyInfo.runs.length,
        'the empty state must carry a title AND a description, not a single bare label (the EmptyState primitive)',
      ).toBeGreaterThanOrEqual(2)
      expect(
        emptyInfo.maxWords,
        'the empty state needs a descriptive line — a real sentence telling the user what goes here, not just a heading word',
      ).toBeGreaterThanOrEqual(3)

      await expect(page.getByRole('status')).toContainText(CONNECTED)
      await expectAxeClean(page, `${route.id}:empty`)
    })

    test('error state renders (and is axe-clean) on a 500, with a retry affordance that works', async ({
      page,
    }) => {
      let failing = true
      await page.route(isDataRequest, async (dataRoute) => {
        if (failing) {
          await dataRoute.fulfill({ ...fulfillJson, status: 500, body: ERROR_BODY })
          return
        }
        await dataRoute.fulfill({ ...fulfillJson, body: EMPTY_PAGE })
      })
      await page.goto(route.path)
      const errorSurface = page.getByTestId(route.states.error)
      await expect(errorSurface).toBeVisible()
      await expectAxeClean(page, `${route.id}:error`)
      // The manifest contract: the error surface CONTAINS its retry control.
      const retry = errorSurface.getByRole('button').first()
      await expect(retry).toBeVisible()
      failing = false
      await retry.click()
      await expect(page.getByTestId(route.states.empty)).toBeVisible()
      await expect(errorSurface).toHaveCount(0)
    })
  })
}
