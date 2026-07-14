import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, makeNoteRows, stubHealthz, stubNotesPages } from './mock-ipc'

// The CI-only interaction-latency lane: wall-clock UX budgets (TTI, arrow-key
// latency, main-thread long tasks) measured in real chromium against `vite dev`.
// This file belongs to the 'perf' Playwright project, which playwright.config.ts
// defines ONLY under HARNESS_PERF_LANE=1 — the default chromium project
// testIgnores it and tools/check-e2e.mjs strips the env var, so the validate
// chain and the Stop hook never run it (their determinism and the warm ≈5s
// promise are inviolable). It runs as the blocking `perf-lane` job in the
// consumer quality-gate workflow instead. Budgets live in
// tools/interaction-budget.json (seeded, write-guard-protected): generous
// shared-runner numbers that catch step-function regressions (a 300ms stall on
// keydown), not 10% drifts — the in-chain perf-budget gate stays the tight
// relative render canary. A missing or malformed budget file FAILS the enabled
// lane (never skips): a lane that cannot find its budget must not read green.
// All timing happens IN PAGE (performance.now() + requestAnimationFrame
// bracketing) — driver round-trips would add tens of ms of IPC noise per sample.
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes) [corpus: harness/doctrine]

// The e2e tsconfig compiles with types:[] (no @types/node — Playwright
// transpiles specs itself); declare the minimal Node surface this spec uses,
// the same pattern playwright.config.ts applies for `process`.
declare const process: { env: { HARNESS_PERF_LANE?: string } }

const PERF_LANE = process.env.HARNESS_PERF_LANE === '1'
// Belt and braces with the config-level project gate: even if this file is ever
// pulled into another project's testMatch, it must never time anything at agent
// time.
test.skip(!PERF_LANE, 'perf lane disabled — set HARNESS_PERF_LANE=1 (CI-only wall-clock lane)')

const BUDGET_PATH = 'tools/interaction-budget.json'
const RE_BASELINE =
  `if this is a DELIBERATE UX change, re-baseline ${BUDGET_PATH} in a reviewed commit: ` +
  'measure locally (HARNESS_PERF_LANE=1 pnpm exec playwright test --project perf), ship ' +
  '~6-8x the local median — the file is write-guard-protected, so the edit is a human decision'

const HOME = ROUTES.find((route) => route.id === 'home')
const MATRIX = ROUTES.find((route) => route.id === 'matrix')

const PAGE_ONE_ROWS = 200 // >> the viewport window — the matrix virtualizes for real
const SERVER_NOTE_ID = 'aaaaaaaa-0000-4000-8000-0000000000fe'

interface InteractionBudget {
  readonly ttiMs: number
  readonly arrowLatencyMs: { readonly median: number }
  readonly longTasks: { readonly max: number; readonly thresholdMs: number }
  readonly runs: number
}

function budgetNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${BUDGET_PATH}: "${field}" must be a positive number (got ${JSON.stringify(value)}) — ` +
        'the enabled perf lane fails closed on an unreviewable budget; fix the file in a reviewed commit',
    )
  }
  return value
}

/** Read + validate the budget. Missing/malformed → THROW (the lane fails, never skips). */
function loadBudget(): InteractionBudget {
  let raw: string
  try {
    raw = readFileSync(BUDGET_PATH, 'utf8')
  } catch {
    throw new Error(
      `${BUDGET_PATH} is MISSING — the enabled perf lane fails closed, never skips-green. ` +
        'Restore it from git; a pre-0.1.5 install adopts it deliberately with ' +
        '`npx tauri-postgres-agent-harness update --refresh-seeded tools/interaction-budget.json`.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${BUDGET_PATH} is not valid JSON (${String(error)}) — the budget must be reviewable data; ` +
        'fix it in a reviewed commit',
    )
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const arrow = (record.arrowLatencyMs ?? {}) as Record<string, unknown>
  const longTasks = (record.longTasks ?? {}) as Record<string, unknown>
  return {
    ttiMs: budgetNumber(record.ttiMs, 'ttiMs'),
    arrowLatencyMs: { median: budgetNumber(arrow.median, 'arrowLatencyMs.median') },
    longTasks: {
      max: budgetNumber(longTasks.max, 'longTasks.max'),
      thresholdMs: budgetNumber(longTasks.thresholdMs, 'longTasks.thresholdMs'),
    },
    runs: budgetNumber(record.runs, 'runs'),
  }
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

const fmtSamples = (samples: readonly number[]): string =>
  samples.map((sample) => sample.toFixed(0)).join('/')

/** Is focus currently inside the grid? (same probe as matrix.spec) */
function focusInGrid(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement
    return el !== null && el !== document.body && el.closest('[role="grid"]') !== null
  })
}

/** Tab until focus enters the grid (bounded walk, same as matrix.spec). */
async function tabIntoGrid(page: Page): Promise<boolean> {
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab')
    if (await focusInGrid(page)) return true
  }
  return false
}

// ── (a) TTI: navigation → the screen is actually usable ───────────────────────
// The marker is recorded IN PAGE: an init script arms a MutationObserver before any app
// code runs and stamps performance.now() (whose time origin is THIS navigation) the first
// time the screen is interactive — the driver only reads the stamp afterwards, so its
// polling latency never inflates a sample. Median of `runs` navigations: the first is
// vite-transform cold, the rest warm; the median converges on the warm value either way.
//
// C03 — the definition is ROUTE-AGNOSTIC, driven off the ROUTES manifest rather than the
// notes exemplar's `[data-note-id]`. "Interactive" = the route's declared loading surface
// is gone AND <main> has rendered content. Every route declares a loading test id, so a
// screen an agent ADDS gets a wall-clock TTI budget the day it registers — previously the
// lane only ever measured home and matrix, so a new dense screen's mount cost was
// enforced by nothing, agent-time or CI.
type PerfWindow = Window & {
  __harnessTtiMs?: number
  __harnessCollectLongTasks?: () => readonly number[]
}

async function installTtiMarker(page: Page, loadingTestId: string): Promise<void> {
  await page.addInitScript((loadingId: string) => {
    const w = window as PerfWindow
    const record = (): boolean => {
      // Still loading → not interactive.
      if (document.querySelector(`[data-testid="${loadingId}"]`) !== null) return false
      // Not mounted yet → not interactive (guards a t≈0 false stamp before React runs).
      const main = document.querySelector('main')
      if (main === null || main.children.length === 0) return false
      w.__harnessTtiMs = performance.now()
      return true
    }
    const observer = new MutationObserver(() => {
      if (record()) observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true })
  }, loadingTestId)
}

// C03: EVERY registered route gets a wall-clock TTI budget, not just the two exemplars.
// A dense screen an agent adds is measured the day it registers in ROUTES.
test('the ROUTES manifest is non-empty (else the TTI sweep below is a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

for (const route of ROUTES) {
  test(`TTI: ${route.id} (${route.path}) navigation → interactive, median under ttiMs`, async ({
    page,
  }) => {
    const budget = loadBudget()
    await installMockIpc(page)
    await installTtiMarker(page, route.states.loading)
    await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
    // A full page of rows: the densest ready state the screen can reach.
    await stubNotesPages(page, [{ items: makeNoteRows(50), nextCursor: null }])

    const samples: number[] = []
    for (let run = 0; run < budget.runs; run += 1) {
      await page.goto(route.path)
      await page.waitForFunction(() => (window as PerfWindow).__harnessTtiMs !== undefined)
      samples.push(await page.evaluate(() => (window as PerfWindow).__harnessTtiMs ?? Number.NaN))
    }
    const measured = median(samples)
    // Green runs print the numbers too — re-baselining reads them from any CI log.
    console.log(
      `[perf] TTI ${route.id} median ${measured.toFixed(0)}ms (budget ${String(budget.ttiMs)}ms; samples ${fmtSamples(samples)}ms)`,
    )
    expect(
      measured,
      `TTI median ${measured.toFixed(0)}ms on ${route.id} exceeds the ${String(budget.ttiMs)}ms budget ` +
        `(${BUDGET_PATH} ttiMs; samples ${fmtSamples(samples)}ms) — something slowed the ` +
        `navigation→content path; ${RE_BASELINE}`,
    ).toBeLessThanOrEqual(budget.ttiMs)
  })
}

// ── (b) arrow-key latency on the roving grid ──────────────────────────────────
// Timed entirely IN PAGE: dispatch a keydown on the focused cell, then poll one
// requestAnimationFrame at a time until the roving focus lands on the next row —
// the sample is keydown → the first frame that shows the moved cell. (The grid
// commits the move synchronously and re-focuses in an effect, so the first rAF
// observing data-row+1 IS the next frame after the change.)

async function measureArrowSamples(runs: number): Promise<readonly number[]> {
  const rowOf = (el: Element | null): number => {
    const raw = el?.getAttribute('data-row')
    return raw === null || raw === undefined ? Number.NaN : Number(raw)
  }
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  const samples: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const cell = document.activeElement
    const row = rowOf(cell)
    if (cell === null || Number.isNaN(row)) {
      throw new Error('focus is not on a grid cell (data-row absent) — cannot measure')
    }
    const start = performance.now()
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    let sample = Number.NaN
    for (let frame = 0; frame < 300; frame += 1) {
      await nextFrame()
      if (rowOf(document.activeElement) === row + 1) {
        sample = performance.now() - start
        break
      }
    }
    if (Number.isNaN(sample)) {
      throw new Error(
        `ArrowDown run ${String(run)}: the focused cell never advanced within 300 frames`,
      )
    }
    samples.push(sample)
  }
  return samples
}

test('arrow-key latency: keydown → next frame after the focused cell moves', async ({ page }) => {
  if (MATRIX === undefined) {
    test.skip(true, 'ROUTES has no "matrix" entry — the app does not ship the grid exemplar')
    return
  }
  const budget = loadBudget()
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubNotesPages(page, [
    { items: makeNoteRows(PAGE_ONE_ROWS), nextCursor: 'cursor-token-page-2' },
    { items: makeNoteRows(50, PAGE_ONE_ROWS), nextCursor: null },
  ])
  await page.goto(MATRIX.path)
  await expect(page.getByRole('grid')).toBeVisible()
  expect(await tabIntoGrid(page), 'focus must reach the grid').toBe(true)

  const samples = await page.evaluate(measureArrowSamples, budget.runs)
  const measured = median(samples)
  console.log(
    `[perf] arrow-key latency median ${measured.toFixed(1)}ms (budget ${String(budget.arrowLatencyMs.median)}ms; samples ${fmtSamples(samples)}ms)`,
  )
  expect(
    measured,
    `arrow-key latency median ${measured.toFixed(1)}ms exceeds the ` +
      `${String(budget.arrowLatencyMs.median)}ms budget (${BUDGET_PATH} arrowLatencyMs.median; ` +
      `samples ${fmtSamples(samples)}ms) — the keydown→frame path picked up main-thread work; ` +
      RE_BASELINE,
  ).toBeLessThanOrEqual(budget.arrowLatencyMs.median)
})

// ── (c) long tasks during a scripted interaction burst ────────────────────────
// PerformanceObserver('longtask') armed IN PAGE right before the burst
// (buffered:true replays entries racing the observer registration; an
// armed-at startTime filter excludes the initial page-load tasks that are not
// the burst's). The burst is every interaction class the app ships, on ONE SPA
// page session: optimistic note create → palette open/type → client-side
// navigation to the matrix → virtual-window scroll sweep → arrow-key walk.

async function armLongTaskObserver(page: Page, thresholdMs: number): Promise<void> {
  await page.evaluate((threshold) => {
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      throw new Error(
        'this chromium exposes no longtask PerformanceObserver entries — the perf lane cannot ' +
          'measure main-thread stalls and fails closed rather than skipping; pin a chromium build ' +
          'that supports longtask (Playwright-bundled chromium does)',
      )
    }
    const w = window as Window & { __harnessCollectLongTasks?: () => readonly number[] }
    const armedAt = performance.now()
    const durations: number[] = []
    const qualifies = (entry: PerformanceEntry): boolean =>
      entry.duration >= threshold && entry.startTime >= armedAt
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (qualifies(entry)) durations.push(Math.round(entry.duration))
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
    w.__harnessCollectLongTasks = () => {
      for (const entry of observer.takeRecords()) {
        if (qualifies(entry)) durations.push(Math.round(entry.duration))
      }
      observer.disconnect()
      return durations
    }
  }, thresholdMs)
}

// One router for the whole burst: GETs serve keyset pages (home + matrix), the
// note-create POST answers 201 with a full NoteDto (the client Zod-parses it on
// reconcile), and OPTIONS answers the JSON POST's CORS preflight.
async function routeBurstData(page: Page): Promise<void> {
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST',
  }
  const [templateRow] = makeNoteRows(1)
  if (templateRow === undefined) throw new Error('makeNoteRows(1) produced no row')
  const serverNote = {
    ...templateRow,
    id: SERVER_NOTE_ID,
    title: 'Perf burst note',
    createdAt: '2026-01-01T00:00:01.000Z',
  }
  const pageOne = { items: makeNoteRows(PAGE_ONE_ROWS), nextCursor: 'cursor-token-page-2' }
  const pageTwo = { items: makeNoteRows(50, PAGE_ONE_ROWS), nextCursor: null }
  await page.route(
    (url) => url.port === '8787' && !url.pathname.endsWith('/healthz'),
    async (route) => {
      const method = route.request().method()
      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders })
        return
      }
      if (method === 'POST') {
        await route.fulfill({
          status: 201,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify(serverNote),
        })
        return
      }
      const hasCursor = new URL(route.request().url()).searchParams.get('cursor') !== null
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: 'application/json',
        body: JSON.stringify(hasCursor ? pageTwo : pageOne),
      })
    },
  )
}

/** Scroll the virtual window through the row space, one step per frame. */
async function scrollSweep(): Promise<void> {
  const grid = document.querySelector('[role="grid"]')
  if (grid === null) throw new Error('no [role="grid"] to scroll')
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  for (let step = 0; step < 24; step += 1) {
    grid.scrollTop = (step % 12) * 600
    await nextFrame()
  }
}

test('long tasks: the interaction burst stays under longTasks.max', async ({ page }) => {
  if (HOME === undefined || MATRIX === undefined) {
    test.skip(true, 'ROUTES lacks the home/matrix exemplars — no burst surface to script')
    return
  }
  const budget = loadBudget()
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await routeBurstData(page)
  await page.goto(HOME.path)
  await expect(page.getByText('Note 1', { exact: true }).first()).toBeVisible()

  await armLongTaskObserver(page, budget.longTasks.thresholdMs)

  // Optimistic create: temp row → 201 reconcile (the mutation.spec worked path).
  // A pre-0.1.5 seeded notes surface has no composer (features/notes is
  // seedOnInitOnly) — the burst simply omits this leg there: the long-task
  // budget is a ceiling over whatever the app ships, not a coverage assert.
  if ((await page.getByLabel('Add a note').count()) > 0) {
    await page.getByLabel('Add a note').fill('Perf burst note')
    await page.getByRole('button', { name: 'Add note' }).click()
    await expect(page.locator(`[data-note-id="${SERVER_NOTE_ID}"]`)).toBeVisible()
  }

  // Palette open → type → Enter: "matrix" uniquely matches "Go to Matrix", so
  // Enter runs the contextual navigation command (client-side pushState — the
  // observer survives; a full reload would lose it and fail the collect below).
  await page.keyboard.press('Control+k')
  await expect(page.locator('dialog[open][aria-label="Command palette"]')).toBeVisible()
  await page.keyboard.type('matrix')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('grid')).toBeVisible()

  // Virtual-window scroll sweep + arrow-key walk on the freshly mounted grid.
  await page.evaluate(scrollSweep)
  expect(await tabIntoGrid(page), 'focus must reach the grid').toBe(true)
  for (let press = 0; press < 10; press += 1) {
    await page.keyboard.press('ArrowDown')
  }

  const longTasks = await page.evaluate(() => {
    const w = window as PerfWindow
    return w.__harnessCollectLongTasks?.() ?? null
  })
  if (longTasks === null) {
    throw new Error(
      'long-task observer state vanished mid-burst — the burst must stay one SPA page session ' +
        '(client-side navigation only); a full reload here is itself a regression',
    )
  }
  console.log(
    `[perf] long tasks ≥${String(budget.longTasks.thresholdMs)}ms during the burst: ` +
      `${String(longTasks.length)} (budget max ${String(budget.longTasks.max)}${longTasks.length > 0 ? `; durations ${fmtSamples(longTasks)}ms` : ''})`,
  )
  expect(
    longTasks.length,
    `${String(longTasks.length)} long task(s) ≥${String(budget.longTasks.thresholdMs)}ms during ` +
      `the interaction burst exceeds longTasks.max=${String(budget.longTasks.max)} ` +
      `(${BUDGET_PATH}; durations ${fmtSamples(longTasks)}ms) — the main thread stalled under ` +
      `user input; ${RE_BASELINE}`,
  ).toBeLessThanOrEqual(budget.longTasks.max)
})
