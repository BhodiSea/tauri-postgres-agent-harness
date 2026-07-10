#!/usr/bin/env node
// Gate: perf-budget (OPT-IN — uncomment the ['perf-budget', ...] line in
// tools/harness.config.mjs after enabling the gate-perf-budget module).
//
// Median-of-N render budget over a synthetic 10k-cell matrix fixture: builds a
// rows×cols React element tree (the data shape the matrix feature renders) and
// measures `renderToString` wall time, N runs after warmup, asserting the MEDIAN
// against tools/perf-budget.json. Median over mean: CI runners spike; a single
// GC pause must not flake the gate, but a real regression shifts the median.
//
// This is deliberately a RELATIVE canary, not a UX metric: it catches "someone
// made cell rendering 5× slower" in the validate chain, cheaply, with no browser.
// When the real matrix feature lands, replace the synthetic fixture with your
// component and/or add a playwright-trace interaction budget on a pinned runner
// (see docs/modules/gate-perf-budget/README.md).
// SOURCE: docs/harness/gates-catalog.md (gate-perf-budget module)
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fail, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'perf-budget'
const BUDGET_PATH = 'tools/perf-budget.json'

const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
const { cells, runs, medianBudgetMs } = budget

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

// Warmup: JIT + module init noise stays out of the measured runs.
for (let i = 0; i < 2; i += 1) renderToString(matrixElement())

const samples = []
for (let i = 0; i < runs; i += 1) {
  const start = performance.now()
  const html = renderToString(matrixElement())
  samples.push(performance.now() - start)
  // Sanity: the render actually produced the matrix (an empty render would be a
  // vacuously fast "pass").
  if (!html.includes('cell-high')) fail(GATE, 'fixture rendered no cells — measurement is vacuous')
}

samples.sort((a, b) => a - b)
const median = samples[Math.floor(samples.length / 2)]
const detail = `${SIDE}×${SIDE} cells, ${runs} runs: median ${median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${samples.map((s) => s.toFixed(0)).join('/')}ms)`

if (median > medianBudgetMs) {
  fail(
    GATE,
    `${detail} — render cost regressed past the budget. Find the regression (or, after a DELIBERATE fixture change, re-baseline tools/perf-budget.json in a reviewed commit).`,
  )
}
ok(GATE, detail)
