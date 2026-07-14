import { expect, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc } from './mock-ipc'

// The CI-only INTEGRATION lane: the one spec where the two halves of the app actually
// meet. Every other e2e spec — and every unit test — mocks the network, which is exactly
// how the desktop shipped for five releases sending NO Authorization header at all:
// the notes list, the optimistic create and the keyset pager each 401 against the real
// server, and all 22 gates, 45 e2e tests and the perf lane stayed green. Nothing owned
// the seam, so nothing caught it.
//
// This lane stubs NOTHING except the Tauri IPC — which is how the webview obtains the
// host-held bearer token, and there is no Tauri host in chromium. Real vite bundle →
// real fetch → real Authorization header → real Hono server in stub-auth mode → real
// Postgres under FORCE RLS. If the desktop's data layer cannot authenticate, this job
// is red.
//
// It belongs to the 'integration' Playwright project, which playwright.config.ts defines
// ONLY under HARNESS_INTEGRATION_LANE=1; tools/check-e2e.mjs strips that variable, so the
// validate chain and the Stop hook never run it (it needs a live server + database, which
// an agent on a plane does not have). It runs as the blocking `integration-lane` job in
// the consumer quality-gate workflow.
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes) [corpus: harness/doctrine]

// State test ids come from the ROUTES manifest, never hand-typed — a renamed surface must
// break the spec that asserts it, not silently pass against a stale literal.
const [HOME, MATRIX] = ROUTES

// The token the CI job minted (apps/server/scripts/mint-dev-token.mjs) and handed to both
// the server (which verifies it) and this lane (whose mocked host hands it to the webview).
declare const process: { env: { APP_ACCESS_TOKEN?: string } } | undefined
const TOKEN = process?.env.APP_ACCESS_TOKEN ?? ''

test.beforeEach(() => {
  expect(TOKEN, 'the integration lane needs a minted APP_ACCESS_TOKEN').not.toBe('')
})

test('the desktop authenticates against the real server: the notes list loads', async ({
  page,
}) => {
  const statuses: number[] = []
  page.on('response', (response) => {
    if (response.url().includes('/api/notes')) statuses.push(response.status())
  })

  await installMockIpc(page, { accessToken: TOKEN })
  await page.goto('/')

  // A real surface resolves — ready or empty, but never the error state, which is what a
  // 401 renders as.
  await expect(page.getByTestId(HOME.states.error)).toBeHidden()
  await expect
    .poll(() => statuses.length, { message: 'the desktop never called /api/notes' })
    .toBeGreaterThan(0)

  // THE assertion this lane exists for: not one request was rejected as unauthenticated.
  expect(statuses, 'the desktop data layer sent an unauthenticated request').not.toContain(401)
})

test('an optimistic create round-trips through the real server and survives a reload', async ({
  page,
}) => {
  await installMockIpc(page, { accessToken: TOKEN })
  await page.goto('/')

  const title = `integration note ${String(Date.now())}`
  await page.getByLabel('Add a note').fill(title)
  await page.getByRole('button', { name: 'Add note' }).click()

  // Reconciled, not rolled back: a failed write REMOVES the optimistic row, so the row
  // surviving with its pending flag cleared means the server accepted the POST.
  const row = page.locator('[data-note-id]', { hasText: title })
  await expect(row).toBeVisible()
  await expect(row).not.toHaveAttribute('data-pending', 'true')

  // And it was really persisted: a fresh load re-fetches from Postgres.
  await page.reload()
  await expect(page.locator('[data-note-id]', { hasText: title })).toBeVisible()
})

test('the dense screen authenticates and renders real rows', async ({ page }) => {
  await installMockIpc(page, { accessToken: TOKEN })
  await page.goto(MATRIX.path)

  await expect(page.getByTestId(MATRIX.states.error)).toBeHidden()
  await expect(page.getByRole('grid')).toBeVisible()
})

test('an unauthenticated desktop shows its error surface, and never a blank screen', async ({
  page,
}) => {
  // The negative control. Without it, a lane that silently STOPPED sending the header
  // would still pass every assertion above if the server also stopped checking it — the
  // vacuous-green class the RLS suite's seeded positive control exists to kill.
  await installMockIpc(page, { accessToken: null })
  await page.goto('/')

  await expect(page.getByTestId(HOME.states.error)).toBeVisible()
})
