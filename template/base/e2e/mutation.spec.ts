import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { en } from '../apps/desktop/src/i18n/catalog'
import {
  installMockIpc,
  makeNoteRows,
  setStoredTheme,
  stubHealthz,
  waitForMotionSettled,
} from './mock-ipc'

// The write-UX lock: the optimistic create-note slice (features/notes
// NoteComposer + useCreateNote) must FEEL instant and never lie. Determinism is
// pure route-interception control — the POST is held open (no fulfill) to pin
// the optimistic window, then released; there is not a single sleep here.
//   1. Held POST → the temp row is on screen, marked pending, BEFORE the server
//      answers; fulfilling 201 reconciles it into the server row (pending
//      affordance drops, the server id lands in the DOM).
//   2. 500 envelope → rollback: the temp row is REMOVED and the envelope's
//      human message surfaces as a toast; the inline zod error and the
//      post-rollback surface are axe-swept in BOTH themes.
// Capability-gated like matrix.spec/palette.spec: an upgraded consumer whose
// SEEDED notes surface predates the composer (features/notes is 0.1.5
// seedOnInitOnly) skips instead of failing — update must never red a clean install.
// SOURCE: harness doctrine — latency feel is a first-class UI concern; the
// optimistic row must never outlive a failed write [corpus: harness/doctrine]

// The fast lane's stub API origin (playwright.config.ts webServer env): every
// non-/healthz request there is a data request owned by this spec's router.
const isDataRequest = (url: URL): boolean =>
  url.port === '8787' && !url.pathname.endsWith('/healthz')

// The JSON POST is a non-simple request: unlike the GETs the other specs stub,
// it rides a CORS preflight, so the router answers OPTIONS too.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST',
} as const

const NEW_TITLE = 'Fresh optimistic note'
const SERVER_NOTE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ENVELOPE_MESSAGE = 'note storage exploded'

// A full NoteDto for the 201 body — the client Zod-parses it on reconcile.
const SERVER_NOTE = {
  id: SERVER_NOTE_ID,
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: NEW_TITLE,
  body: '',
  createdAt: '2026-01-01T00:00:01.000Z',
  embedding: null,
  sourceConfidence: null,
  sourceModel: null,
}

const READY_PAGE = JSON.stringify({ items: makeNoteRows(2), nextCursor: null })
const ERROR_ENVELOPE = JSON.stringify({
  error: { code: 'internal', message: ENVELOPE_MESSAGE },
})

interface PostStub {
  readonly status: number
  readonly body: string
  /** When present, the POST is HELD until this promise resolves — the optimistic window. */
  readonly gate?: Promise<void>
}

// One router: GETs serve a ready two-note page, OPTIONS answers the preflight,
// and the POST behaves per stub (held and/or failing).
async function routeNotes(page: Page, post: PostStub): Promise<void> {
  await page.route(isDataRequest, async (route) => {
    const method = route.request().method()
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS })
      return
    }
    if (method === 'POST') {
      await post.gate
      await route.fulfill({
        status: post.status,
        headers: CORS_HEADERS,
        contentType: 'application/json',
        body: post.body,
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: READY_PAGE,
    })
  })
}

/** Skip on a pre-optimistic-notes consumer: the composer (features/notes
 *  NoteComposer) is 0.1.5 seedOnInitOnly starting content, so an upgraded
 *  0.1.4 install runs this OWNED spec against a home screen with no
 *  "Add a note" field — skip instead of failing, the same capability gate
 *  palette.spec applies to the pre-grouped palette. */
async function skipUnlessComposer(page: Page): Promise<void> {
  const composer = await page.getByLabel('Add a note').count()
  test.skip(
    composer === 0,
    'notes surface predates the optimistic create exemplar (pre-0.1.5 seeded features/notes)',
  )
}

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

test('optimistic insert: the pending row renders BEFORE the POST resolves, then reconciles to the server row', async ({
  page,
}) => {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await routeNotes(page, { status: 201, body: JSON.stringify(SERVER_NOTE), gate })

  await page.goto('/')
  await expect(page.getByText('Note 1', { exact: true })).toBeVisible()
  await skipUnlessComposer(page)

  await page.getByLabel('Add a note').fill(NEW_TITLE)
  await page.getByRole('button', { name: 'Add note' }).click()

  // The POST is still HELD — everything visible now is the optimistic state:
  // the temp row at the list head with its pending affordance, and the
  // disabled in-flight submit control.
  const pendingRow = page.locator('li[data-pending="true"]')
  await expect(pendingRow).toBeVisible()
  // The row's title is its own element: a reconciled row also carries a <time> with the
  // server's creation instant, and an optimistic one deliberately does NOT (the client does
  // not know when the note was created — the server assigns that).
  await expect(pendingRow.locator('span').first()).toHaveText(NEW_TITLE)
  await expect(pendingRow.locator('time')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Adding…' })).toBeDisabled()

  release()

  // Reconciliation: the SERVER id lands on the row, the pending affordance
  // drops, the composer re-arms, and the draft clears.
  const serverRow = page.locator(`li[data-note-id="${SERVER_NOTE_ID}"]`)
  await expect(serverRow).toBeVisible()
  await expect(serverRow.locator('span').first()).toHaveText(NEW_TITLE)
  // Reconciliation brought the server's timestamp with it — the row now says when it was made.
  await expect(serverRow.locator('time')).toHaveCount(1)
  await expect(page.locator('li[data-pending="true"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add note' })).toBeEnabled()
  await expect(page.getByLabel('Add a note')).toHaveValue('')
})

for (const theme of ['dark', 'light'] as const) {
  test(`rollback (${theme}): a 500 envelope removes the row, toasts its message; error states are axe-clean`, async ({
    page,
  }) => {
    await installMockIpc(page, { pinTheme: false })
    await setStoredTheme(page, theme)
    // axe must read resting contrast, never a mid-transition frame.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
    await routeNotes(page, { status: 500, body: ERROR_ENVELOPE })

    await page.goto('/')
    await expect(page.getByText('Note 1', { exact: true })).toBeVisible()
    await skipUnlessComposer(page)

    // Inline contract validation first: an empty title never reaches the
    // network; the zod message renders through Field's error line, wired to
    // the control via aria-describedby + aria-invalid.
    await page.getByRole('button', { name: 'Add note' }).click()
    const input = page.getByLabel('Add a note')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    const describedBy = await input.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    await expect(page.locator(`[id="${describedBy ?? ''}"]`)).toBeVisible()
    await waitForMotionSettled(page)
    await expectAxeClean(page, `mutation:${theme}:inline-error`)

    // Now a valid title against the failing POST: rollback + envelope toast.
    await input.fill(NEW_TITLE)
    await page.getByRole('button', { name: 'Add note' }).click()

    // The toast carries TRANSLATED copy, chosen by the envelope's stable `code`. It used to
    // carry the server's raw English message, so a user watching their note fail to save was
    // handed "note storage exploded" — a log line, in a language the app does not choose.
    const failureCopy = en['error.api.internal']
    await expect(page.getByText(failureCopy)).toBeVisible()
    await expect(page.getByText(ENVELOPE_MESSAGE)).toHaveCount(0)

    // …and it LOOKS like a failure. A lost write used to render in exactly the same
    // pixels as "Theme: dark" — same border, same ink — so the only channel telling a
    // user their data had not been saved was the prose inside the box. The failure toast
    // is now announced assertively (role=alert) and painted with the danger token; the
    // computed colour is compared against the neutral chrome around it, so the assertion
    // holds in BOTH themes without hard-coding either theme's values.
    const failureToast = page.getByRole('alert').filter({ hasText: failureCopy })
    await expect(failureToast).toBeVisible()
    const [toastBorder, neutralBorder] = await Promise.all([
      failureToast.evaluate((node) => getComputedStyle(node).borderLeftColor),
      // The composer's own border is the same `edge` token every neutral surface uses.
      input.evaluate((node) => getComputedStyle(node).borderLeftColor),
    ])
    expect(
      toastBorder,
      'the failure toast is painted with the neutral edge token — a lost write is indistinguishable from a confirmation',
    ).not.toBe(neutralBorder)

    // Rollback: no pending row survives, and the title exists only as the
    // preserved draft in the input — never as a phantom list row.
    await expect(page.locator('li[data-pending="true"]')).toHaveCount(0)
    await expect(page.locator('li', { hasText: NEW_TITLE })).toHaveCount(0)
    await expect(input).toHaveValue(NEW_TITLE)
    await waitForMotionSettled(page)
    await expectAxeClean(page, `mutation:${theme}:rollback-toast`)
  })
}
