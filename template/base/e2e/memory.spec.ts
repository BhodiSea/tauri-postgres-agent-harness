import { readFileSync } from 'node:fs'
import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, makeNoteRows, stubDataRequests, stubHealthz } from './mock-ipc'

// The MEMORY CEILING (v0.1.6) — the CI half of the leak controls.
//
// Before 0.1.6 the harness observed memory NOWHERE. Not one check, at any layer. That hole
// has a characteristic shape: an effect that subscribes and never unsubscribes costs nothing
// on first mount, so the render benchmark (which mounts once) sees a flat line and the e2e
// suite (which never navigates back) sees a passing app. The cost appears only in a long
// session — what users call "it gets slow after a while" — and by then no gate is watching.
//
// So this lane does the one thing that exposes it: it MOUNTS AND UNMOUNTS EVERY SCREEN, over
// and over, and then asks what is still alive. A component that tears itself down returns to
// the state it started in; a leaky one leaves something behind on every cycle, linearly.
//
// WHAT IS MEASURED, AND WHY IT IS NOT THE OBVIOUS THING.
//
// The obvious instrument is CDP's Performance.getMetrics — JSEventListeners, Nodes,
// JSHeapUsedSize. It was built first, and then it was CALIBRATED against a deliberately
// leaked window listener, which is the whole point of a control. It failed:
//
//     8 navigate-and-back cycles      clean app        leaking app
//     JSEventListeners (CDP)          189 → 189        190 → 190     <- never moves
//     Nodes                           362 → 535        362 → 535     <- identical
//     JSHeapUsedSize                  +832 kB          +229 kB       <- clean grew MORE
//
// Every one of those would have shipped GREEN on a blatant leak, and two of them make the
// clean app look worse than the broken one. A check that cannot tell the defect from its
// absence is not a weak check, it is a FAKE one — it converts "unmeasured" into "verified",
// which is worse than no check at all. They are not asserted here.
//
// What works is counting LIVE LISTENERS ON LONG-LIVED TARGETS. window and document outlive
// every component, so a listener left on them is a true leak — nothing will ever collect it.
// Listeners on ephemeral targets (an AbortSignal, a node that gets detached) are NOT counted,
// because the garbage collector reclaims those without an explicit removeEventListener, and
// counting raw add/remove CALLS reports them as leaks forever (measured: +1/cycle of pure
// false positive on the clean app). Instrumenting the prototype before any app code runs and
// keeping a live count per (target, event type) gives a clean, integer, deterministic signal:
//
//     live window+document listeners   clean: 8 → 8  (+0)     leaking: 14 → 30  (+16)
//
// Zero versus sixteen. That is a control.
//
// The heap ceiling is kept as a deliberately COARSE backstop for the one class the listener
// count cannot see — retention that holds no listener at all (a module-level cache that only
// grows, an unbounded array). Its budget is loose because, as the table above shows, heap
// under `vite dev` drifts by hundreds of kB per run from the dev server itself. It will catch
// a leak retaining megabytes; it will not catch a subtle one, and it does not pretend to.
// Detached-DOM accounting (a real heap-snapshot walk) is the honest gap here — see
// docs/harness/gates-catalog.md.
//
// CI-only, like the interaction-latency lane and for the same reason: browser-driven and
// shared-runner-noisy. It belongs to the 'perf' Playwright project, which playwright.config.ts
// defines ONLY under HARNESS_PERF_LANE=1 — the default chromium project testIgnores it and
// tools/check-e2e.mjs strips the env var, so the validate chain and the Stop hook never run
// it. It runs as the blocking `perf-lane` job instead. Its agent-time counterpart is the
// effect-cleanup scan in tools/check-perf-budget.mjs, which catches the shapes that are
// visible statically; this lane catches the ones that are not.
// SOURCE: Chrome DevTools Protocol — HeapProfiler.collectGarbage forces a collection so a
// reading reflects REACHABLE memory rather than uncollected garbage
// https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage
// [corpus: harness/doctrine]

// The e2e tsconfig compiles with types:[] (no @types/node — Playwright transpiles specs
// itself); declare the minimal Node surface this spec uses.
declare const process: { env: { HARNESS_PERF_LANE?: string } }

const PERF_LANE = process.env.HARNESS_PERF_LANE === '1'
// Belt and braces with the config-level project gate: even if this file is ever pulled into
// another project's testMatch, it must never run at agent time.
test.skip(!PERF_LANE, 'perf lane disabled — set HARNESS_PERF_LANE=1 (CI-only wall-clock lane)')

const BUDGET_PATH = 'tools/interaction-budget.json'

interface MemoryBudget {
  readonly loops: number
  readonly listenerGrowth: number
  readonly heapGrowthKb: number
}

// Adoption vs. correctness — two different postures, deliberately:
//
//   "memory" ABSENT  → self-disable. tools/interaction-budget.json is SEEDED, so `update`
//     never rewrites it: a 0.1.5 consumer's copy predates this block, and a hard failure
//     would ambush their first 0.1.6 run over a budget they were never given a chance to set.
//     They get the adoption command instead.
//
//   "memory" PRESENT but malformed → FAIL. Once adopted, a budget that cannot be read must
//     never silently read green — that is the exact failure mode this release exists to close.
function loadMemoryBudget(): MemoryBudget | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`${BUDGET_PATH} is missing or not valid JSON (${String(error)})`)
  }
  const memory = (raw as { memory?: unknown }).memory
  if (memory === undefined) return null
  if (memory === null || typeof memory !== 'object') {
    throw new Error(`${BUDGET_PATH} "memory" must be an object — got ${JSON.stringify(memory)}`)
  }
  const numeric = (key: keyof MemoryBudget): number => {
    const value = (memory as Record<string, unknown>)[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `${BUDGET_PATH} "memory".${key} must be a non-negative number — got ${JSON.stringify(value)}.\n` +
          'The memory ceiling is reviewable data: { "memory": { "loops": 8, "listenerGrowth": 2, "heapGrowthKb": 4096 } }',
      )
    }
    return value
  }
  const budget = {
    loops: numeric('loops'),
    listenerGrowth: numeric('listenerGrowth'),
    heapGrowthKb: numeric('heapGrowthKb'),
  }
  if (budget.loops < 2) {
    throw new Error(`${BUDGET_PATH} "memory".loops must be >= 2 — one cycle cannot show growth`)
  }
  return budget
}

const ADOPT_MEMORY_BUDGET =
  `${BUDGET_PATH} has no "memory" block — the leak ceiling is INACTIVE, so a listener leak ` +
  'would ship green. The budget file is seeded (yours to tune), so `update` cannot add the ' +
  'block for you. Adopt it by adding: "memory": { "loops": 8, "listenerGrowth": 2, ' +
  '"heapGrowthKb": 4096 } — or pull the refreshed default with ' +
  '`npx tauri-postgres-agent-harness update --refresh-seeded tools/interaction-budget.json` ' +
  '(that OVERWRITES any budgets you have tuned). See docs/harness/gates-catalog.md, CI-only lanes.'

/**
 * Instrument EventTarget BEFORE any application code runs, and keep a live count per event
 * type for the two targets that outlive every component. add → +1, remove → −1, so the number
 * is what is CURRENTLY registered, not how many calls were ever made.
 */
async function installListenerCensus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const live = new Map<string, number>()
    ;(window as unknown as { __listenerCensus: Map<string, number> }).__listenerCensus = live
    // Only window and document. A listener on anything else dies with its target when the GC
    // gets to it, and counting those reports phantom leaks on a perfectly clean app.
    const scope = (target: EventTarget): string | null =>
      target === window ? 'window' : target === document ? 'document' : null
    const bump = (target: EventTarget, type: string, delta: number): void => {
      const where = scope(target)
      if (where === null) return
      const key = `${where}:${type}`
      live.set(key, (live.get(key) ?? 0) + delta)
    }
    /* eslint-disable @typescript-eslint/unbound-method -- capturing the originals in order to
       delegate to them IS the point of instrumenting a prototype. Both are re-invoked below with
       .call(this), so the receiver is never lost — which is the only thing this rule guards. */
    const originalAdd = EventTarget.prototype.addEventListener
    const originalRemove = EventTarget.prototype.removeEventListener
    /* eslint-enable @typescript-eslint/unbound-method */
    EventTarget.prototype.addEventListener = function (this: EventTarget, type, listener, options) {
      bump(this, type, 1)
      originalAdd.call(this, type, listener, options)
    }
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type,
      listener,
      options,
    ) {
      bump(this, type, -1)
      originalRemove.call(this, type, listener, options)
    }
  })
}

interface Sample {
  /** Live window/document listeners, keyed `<target>:<event type>`. */
  readonly listeners: ReadonlyMap<string, number>
  readonly listenerTotal: number
  readonly heapKb: number
}

/** Force a collection, then read the census and the heap. What survives this is REACHABLE. */
async function sampleAfterGc(page: Page, cdp: CDPSession): Promise<Sample> {
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const heapBytes = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  const entries = await page.evaluate(() =>
    Array.from(
      (window as unknown as { __listenerCensus: Map<string, number> }).__listenerCensus.entries(),
    ),
  )
  const listeners = new Map(entries)
  let listenerTotal = 0
  for (const count of listeners.values()) listenerTotal += count
  return { listeners, listenerTotal, heapKb: Math.round(heapBytes / 1024) }
}

// One full cycle: visit every route IN-PAGE, then come back to where we started.
//
// It must be in-page, and that is the single most important line in this file. page.goto() is
// a full document load: it destroys the JS context, and with it every listener, every node and
// the whole heap. A leak measured across goto() calls always reads ZERO, because the browser
// cleans up what the app did not — the probe would be a guaranteed pass on a leaking app.
//
// So navigation goes through the app's OWN router, by clicking the real nav links a user
// clicks (the shell's pushState router intercepts them). The document persists across the whole
// loop; only the screens mount and unmount. That is exactly the lifecycle a leak lives in.
async function navigateCycle(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary' })
  for (const route of ROUTES) {
    await nav.getByRole('link', { name: route.label, exact: true }).click()
    // Wait for the screen to actually mount. A cycle that moves on before the component's
    // effects have run would never register the listeners we are hunting, and the whole probe
    // would be a vacuous pass.
    await expect(page.locator('main')).not.toBeEmpty()
  }
  await nav.getByRole('link', { name: ROUTES[0].label, exact: true }).click()
  await expect(page.locator('main')).not.toBeEmpty()
}

/** Per-event-type deltas, worst first — so the failure NAMES the leak instead of just counting it. */
function listenerDeltas(before: Sample, after: Sample): string[] {
  const keys = new Set([...before.listeners.keys(), ...after.listeners.keys()])
  return [...keys]
    .map((key) => ({
      key,
      delta: (after.listeners.get(key) ?? 0) - (before.listeners.get(key) ?? 0),
      from: before.listeners.get(key) ?? 0,
      to: after.listeners.get(key) ?? 0,
    }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => b.delta - a.delta)
    .map(
      (row) => `    ${row.key}: ${String(row.from)} → ${String(row.to)}  (+${String(row.delta)})`,
    )
}

test('the ROUTES manifest is non-empty (else this memory suite is a vacuous pass)', () => {
  expect(ROUTES.length).toBeGreaterThan(0)
})

test('mounting and unmounting every screen repeatedly leaks no listeners and no heap', async ({
  page,
}) => {
  const budget = loadMemoryBudget()
  test.skip(budget === null, ADOPT_MEMORY_BUDGET)
  if (budget === null) return // narrows the type; test.skip above already ended the run

  await installListenerCensus(page) // BEFORE any app code — it patches the prototype
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  // A real page of rows on every data request: an empty list mounts almost nothing, and a leak
  // that retains rendered rows is precisely the one worth catching.
  await stubDataRequests(page, { items: makeNoteRows(50), nextCursor: null })

  // The ONE document load. Everything after this is in-page routing (see navigateCycle): the
  // JS context has to survive the whole loop, or there is nothing left to leak.
  await page.goto(ROUTES[0].path)
  await expect(page.locator('main')).not.toBeEmpty()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')

  // WARMUP. The first cycles are not comparable: lazy route chunks arrive, module singletons
  // initialize, caches fill, the JIT warms. That is one-time cost, not a leak, and baselining
  // from a cold start would report it as one. Baseline AFTER the app reaches steady state —
  // from here, any further growth is growth that REPEATS.
  await navigateCycle(page)
  await navigateCycle(page)
  const before = await sampleAfterGc(page, cdp)

  for (let i = 0; i < budget.loops; i += 1) await navigateCycle(page)
  const after = await sampleAfterGc(page, cdp)

  // Non-vacuous: if the census saw nothing at all, the instrumentation did not take (a
  // renamed nav, a changed router) and every assertion below would pass for the wrong reason.
  expect(
    before.listenerTotal,
    'the listener census recorded ZERO live window/document listeners after warmup — the ' +
      'instrumentation did not take (did the app stop using window/document listeners, or did ' +
      'navigateCycle fail to mount anything?). A leak check that measures nothing always passes.',
  ).toBeGreaterThan(0)

  const listenerGrowth = after.listenerTotal - before.listenerTotal
  const heapGrowth = after.heapKb - before.heapKb
  const cycles = `over ${String(budget.loops)} navigate-and-back cycles across ${String(ROUTES.length)} route(s)`

  expect(
    listenerGrowth,
    `LISTENER LEAK — ${cycles}, live window/document listeners grew ` +
      `${String(before.listenerTotal)} → ${String(after.listenerTotal)} (+${String(listenerGrowth)}, ` +
      `budget +${String(budget.listenerGrowth)}):\n${listenerDeltas(before, after).join('\n')}\n` +
      '  These targets OUTLIVE every component, so nothing will ever collect these — the count\n' +
      '  grows for as long as the app runs. Growth that scales with the cycle count is a leak,\n' +
      '  not noise: the app came back to the same screen with the same data, so a correct\n' +
      '  component tree must come back to the same count.\n' +
      '  FIX: the effect that registers each listener above must return a cleanup that removes\n' +
      '  it. The event type in the delta names it. (tools/check-perf-budget.mjs catches this\n' +
      '  statically for the common shapes — if it did not, the registration is happening\n' +
      '  somewhere the static scan cannot see, e.g. behind a helper.)',
  ).toBeLessThanOrEqual(budget.listenerGrowth)

  expect(
    heapGrowth,
    `HEAP RETENTION — ${cycles}, the JS heap grew ${String(before.heapKb)}kB → ${String(after.heapKb)}kB ` +
      `(+${String(heapGrowth)}kB, budget +${String(budget.heapGrowthKb)}kB) while listener counts stayed ` +
      'within budget.\n' +
      '  This budget is COARSE by construction (the dev server itself drifts by hundreds of kB),\n' +
      '  so crossing it means something is retaining MEGABYTES per run — look for a module-level\n' +
      '  cache or array that only ever grows, or a closure captured in a long-lived singleton.',
  ).toBeLessThanOrEqual(budget.heapGrowthKb)
})
