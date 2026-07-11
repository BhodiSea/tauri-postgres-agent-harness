#!/usr/bin/env node
// Gate: perf-budget — default-on since v0.1.3 (promoted from the gate-perf-budget
// module).
//
// Median-of-N render budget over a synthetic 10k-cell matrix fixture: builds a
// rows×cols React element tree (the data shape the matrix feature renders) and
// measures `renderToString` wall time, N runs after warmup, asserting the MEDIAN
// against tools/perf-budget.json (write-guard-protected — raising the budget is a
// reviewed human decision). Median over mean: runners spike; a single GC pause
// must not flake the gate, but a real regression shifts the median. Belt and
// braces, the gate RE-MEASURES ONCE before failing — a red requires two
// independent over-budget medians, so scheduler noise cannot fail a turn while a
// genuine 10x regression still cannot pass.
//
// This is deliberately a RELATIVE canary, not a UX metric: it catches "someone
// made cell rendering 5× slower" in the validate chain, cheaply, with no browser.
// The budget ships ~10× above a fresh-scaffold median so real features fit; when
// the real matrix feature lands, replace the synthetic fixture with your component
// and/or add a playwright-trace interaction budget on a pinned runner.
// SOURCE: docs/harness/gates-catalog.md (perf-budget gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fail, ok, skipOrFail } from './lib/gate.mjs'

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
