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
      await expect(page.getByTestId(route.states.loading)).toBeVisible()
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
      await expect(page.getByTestId(route.states.empty)).toBeVisible()
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
