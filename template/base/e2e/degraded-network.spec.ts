import { expect, test } from '@playwright/test'
import { installMockIpc, stubHealthz } from './mock-ipc'

// Degraded-network doctrine: a dead or misbehaving API must surface as a calm,
// polite live-region state — never a crash, never a blank shell. Both failure
// shapes are exercised: an HTTP 500 from /healthz and a refused connection.
// Each spec awaits the intercepted probe request first, so the assertion covers
// the PROBED degraded state, not just the component's initial render.
// SOURCE: harness doctrine — degraded-network states are a first-class UI concern
// [corpus: harness/doctrine]

const DEGRADED_TEXT = 'API unreachable — retrying'

test('healthz 500 → ConnectionStatus renders the degraded state (role=status, aria-live)', async ({
  page,
}) => {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'http-error', status: 500 })

  const firstProbe = page.waitForRequest('**/healthz')
  await page.goto('/')
  await firstProbe // the probe actually ran — this is not the pre-fetch default state

  const status = page.getByRole('status')
  await expect(status).toContainText(DEGRADED_TEXT)
  await expect(status).toHaveAttribute('aria-live', 'polite')

  // The rest of the shell stays fully functional around the degraded indicator.
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('banner')).toBeVisible()
})

test('connection refused → ConnectionStatus renders the degraded state', async ({ page }) => {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'offline' })

  const firstProbe = page.waitForRequest('**/healthz')
  await page.goto('/')
  await firstProbe

  const status = page.getByRole('status')
  await expect(status).toContainText(DEGRADED_TEXT)
  await expect(status).toHaveAttribute('aria-live', 'polite')
})

test('a degraded body shape (ok: false) fails the zod probe → degraded state', async ({ page }) => {
  await installMockIpc(page)
  // 200 with a non-conforming body: HealthResponse pins `ok: literal(true)`, so
  // the shape probe must reject it — a lying API is degraded, not connected.
  await page.route('**/healthz', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, version: 'x' }),
    })
  })

  const firstProbe = page.waitForRequest('**/healthz')
  await page.goto('/')
  await firstProbe

  await expect(page.getByRole('status')).toContainText(DEGRADED_TEXT)
})
