#!/usr/bin/env node
// Gate: perf-budget — default-on since v0.1.3 (promoted from the gate-perf-budget
// module).
//
// Median-of-N render budget over the matrix feature: N runs after warmup measure
// `renderToString` wall time and assert the MEDIAN against tools/perf-budget.json
// (write-guard-protected — raising the budget is a reviewed human decision).
// Median over mean: runners spike; a single GC pause must not flake the gate, but
// a real regression shifts the median. Belt and braces, the gate RE-MEASURES ONCE
// before failing — a red requires two independent over-budget medians, so
// scheduler noise cannot fail a turn while a genuine 10x regression still cannot
// pass.
//
// TWO measurement paths, selected by whether budget.subject is declared:
//   • subject PRESENT (the shipped path) — spawn `pnpm --filter desktop exec tsx`
//     on tools/lib/perf-subject-cli.mjs, which renders the REAL MatrixGrid via
//     apps/desktop/src/features/matrix/perfSubject.ts. budget.subject is resolved
//     relative to the SCAFFOLD ROOT (process.cwd()). A missing subject file,
//     unresolvable tsx, spawn failure, malformed CLI output, or a vacuous render
//     is a hard FAIL with a named reason — NEVER a silent fallback to the
//     synthetic path.
//   • subject ABSENT (legacy pre-0.1.4 budgets) — the in-process synthetic
//     rows×cols fixture below, byte-for-byte as it shipped in 0.1.3.
//
// This is deliberately a RELATIVE canary, not a UX metric: it catches "someone
// made cell rendering 5× slower" in the validate chain, cheaply, with no browser.
// The budget ships ~10× above a fresh-scaffold median so real features fit; add a
// playwright-trace interaction budget on a pinned runner for absolute UX numbers.
// SOURCE: docs/harness/gates-catalog.md (perf-budget gate) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, MAX_BUFFER, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'perf-budget'
const BUDGET_PATH = 'tools/perf-budget.json'

if (!existsSync('apps/desktop/package.json'))
  skipOrFail(GATE, 'apps/desktop not found (no desktop surface yet)')
if (!existsSync(BUDGET_PATH)) {
  fail(GATE, `${BUDGET_PATH} missing — the render budget must exist as reviewable data; restore it`)
}
let budget
try {
  budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
} catch (e) {
  fail(GATE, `${BUDGET_PATH} is not valid JSON (${e.message}) — the budget must be reviewable data`)
}
const { cells, runs, medianBudgetMs } = budget
if (![cells, runs, medianBudgetMs].every((v) => typeof v === 'number' && v > 0)) {
  fail(GATE, `${BUDGET_PATH} must carry positive numbers for cells, runs, medianBudgetMs`)
}

// ---- real-subject path: measure the actual matrix component via tsx -----------
if (typeof budget.subject === 'string' && budget.subject.trim() !== '') {
  const subjectAbs = resolve(process.cwd(), budget.subject)
  if (!existsSync(subjectAbs)) {
    fail(
      GATE,
      `budget.subject "${budget.subject}" does not exist (resolved ${subjectAbs}) — the declared perf subject is missing; restore it or drop "subject" from ${BUDGET_PATH}`,
    )
  }
  const cliAbs = fileURLToPath(new URL('./lib/perf-subject-cli.mjs', import.meta.url))

  // One measurement = one CLI spawn. tsx resolves react/react-dom from the desktop
  // workspace and transpiles the TS import graph; shell:true lets Windows run the
  // `pnpm`/`tsx` .cmd shims. Any non-zero exit or unusable stdout is a FAIL — the
  // gate never quietly substitutes the synthetic fixture.
  function measureViaSubject() {
    const res = spawnSync(
      'pnpm',
      ['--filter', 'desktop', 'exec', 'tsx', cliAbs, subjectAbs, String(cells), String(runs)],
      { cwd: process.cwd(), encoding: 'utf8', shell: true, maxBuffer: MAX_BUFFER },
    )
    if (res.error) {
      fail(
        GATE,
        `could not spawn the perf subject via \`pnpm --filter desktop exec tsx\` (${res.error.message}) — run pnpm install / fix tsx; the gate never falls back to a synthetic measurement`,
      )
    }
    if (res.status !== 0) {
      const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`
        .trim()
        .split('\n')
        .slice(-4)
        .join(' | ')
      fail(
        GATE,
        `the real perf subject failed to measure (exit ${res.status}) via \`pnpm --filter desktop exec tsx ${budget.subject}\`: ${detail} — fix the subject or the toolchain; the gate never falls back to a synthetic measurement`,
      )
    }
    let parsed
    for (const line of (res.stdout ?? '').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        parsed = JSON.parse(t)
      } catch {
        /* not the samples line — keep scanning */
      }
    }
    const okShape =
      parsed !== undefined &&
      Array.isArray(parsed.samples) &&
      parsed.samples.length === runs &&
      parsed.samples.every((s) => typeof s === 'number' && Number.isFinite(s))
    if (!okShape) {
      fail(
        GATE,
        `the perf subject CLI did not emit a valid {"samples":[…]} line of ${runs} numbers (stdout: ${JSON.stringify((res.stdout ?? '').slice(0, 200))}) — measurement is unusable`,
      )
    }
    const sorted = [...parsed.samples].sort((a, b) => a - b)
    return { median: sorted[Math.floor(sorted.length / 2)], samples: parsed.samples }
  }

  let { median, samples } = measureViaSubject()
  let retried = false
  if (median > medianBudgetMs) {
    // One full re-measure before failing: two independent over-budget medians
    // cannot both be scheduler noise.
    retried = true
    ;({ median, samples } = measureViaSubject())
  }
  const detail = `subject ${budget.subject}, ${cells} cells, ${runs} runs${retried ? ' (re-measured once)' : ''}: median ${median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${samples.map((s) => s.toFixed(0)).join('/')}ms)`
  if (median > medianBudgetMs) {
    fail(
      GATE,
      `${detail} — render cost regressed past the budget twice in a row. Find the regression (or, after a DELIBERATE change to the subject, re-baseline ${BUDGET_PATH} in a reviewed commit).`,
    )
  }
  ok(GATE, detail)
}

// ---- legacy synthetic path (budgets without a subject, pre-0.1.4) --------------
let React
let renderToString
try {
  const requireFromDesktop = createRequire(`${process.cwd()}/apps/desktop/package.json`)
  React = requireFromDesktop('react')
  ;({ renderToString } = requireFromDesktop('react-dom/server'))
} catch {
  skipOrFail(GATE, 'react/react-dom not resolvable from apps/desktop (run pnpm install)')
}

const SIDE = Math.round(Math.sqrt(cells))

// Synthetic matrix: rows×cols of cells with data-derived classes and text —
// the same order of DOM weight a real matrix screen produces per render.
function matrixElement() {
  const rows = []
  for (let r = 0; r < SIDE; r += 1) {
    const rowCells = []
    for (let c = 0; c < SIDE; c += 1) {
      const value = (r * 31 + c * 17) % 100
      rowCells.push(
        React.createElement(
          'td',
          {
            key: c,
            className: value > 50 ? 'cell cell-high' : 'cell cell-low',
            'data-value': value,
          },
          String(value),
        ),
      )
    }
    rows.push(React.createElement('tr', { key: r }, rowCells))
  }
  return React.createElement(
    'table',
    { className: 'matrix' },
    React.createElement('tbody', null, rows),
  )
}

function measureMedian() {
  // Warmup: JIT + module init noise stays out of the measured runs.
  for (let i = 0; i < 2; i += 1) renderToString(matrixElement())
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    const html = renderToString(matrixElement())
    samples.push(performance.now() - start)
    // Sanity: the render actually produced the matrix (an empty render would be
    // a vacuously fast "pass").
    if (!html.includes('cell-high'))
      fail(GATE, 'fixture rendered no cells — measurement is vacuous')
  }
  samples.sort((a, b) => a - b)
  return { median: samples[Math.floor(samples.length / 2)], samples }
}

let { median, samples } = measureMedian()
let retried = false
if (median > medianBudgetMs) {
  // One full re-measure before failing: two independent over-budget medians
  // cannot both be scheduler noise.
  retried = true
  ;({ median, samples } = measureMedian())
}

const detail = `${SIDE}×${SIDE} cells, ${runs} runs${retried ? ' (re-measured once)' : ''}: median ${median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${samples.map((s) => s.toFixed(0)).join('/')}ms)`

if (median > medianBudgetMs) {
  fail(
    GATE,
    `${detail} — render cost regressed past the budget twice in a row. Find the regression (or, after a DELIBERATE fixture change, re-baseline tools/perf-budget.json in a reviewed commit).`,
  )
}
ok(GATE, detail)
