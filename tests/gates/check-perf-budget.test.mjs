// Can-fail + can-pass proofs for the perf-budget gate
// (template/base/tools/check-perf-budget.mjs). Fixture-driven like the
// route-manifest suite: build a scaffold-shaped tree, run the REAL gate with cwd
// inside it, assert the exact red/green.
//
// The gate resolves react + react-dom/server from apps/desktop via createRequire,
// then measures renderToString wall time over a synthetic rows×cols matrix. To
// stay install-free we plant a MINIMAL CommonJS stub react / react-dom-server in
// the fixture's apps/desktop/node_modules — enough surface for createElement +
// renderToString (the stub emits `class="…"`, so the gate's `cell-high` vacuity
// check sees real output). The stub is faster than real React, so a generous
// budget greens and a sub-microsecond budget reds; the timing shape (median-of-N,
// re-measure-once) is what we pin, not absolute milliseconds.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-perf-budget.mjs', import.meta.url),
)
const SHIPPED_BUDGET_PATH = fileURLToPath(
  new URL('../../template/base/tools/perf-budget.json', import.meta.url),
)

// Minimal CommonJS react: createElement returns a plain node; a lone array child
// (the gate passes rowCells / rows as the third arg) is spread to children.
const REACT_STUB = `'use strict'
function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2)
  if (children.length === 1 && Array.isArray(children[0])) children = children[0]
  return { type: type, props: props || {}, children: children }
}
module.exports = { createElement: createElement }
`

// Minimal react-dom/server: recursively serialize the node tree, emitting the
// className as `class="…"` so the gate's `html.includes('cell-high')` sanity
// check passes on a real (non-vacuous) render.
const REACT_DOM_SERVER_STUB = `'use strict'
function render(node) {
  if (node == null || node === false) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object') return String(node)
  var props = node.props || {}
  var cls = props.className ? ' class="' + props.className + '"' : ''
  return '<' + node.type + cls + '>' + render(node.children) + '</' + node.type + '>'
}
module.exports = { renderToString: render }
`

function plantReactStub(dir) {
  const react = join(dir, 'apps/desktop/node_modules/react')
  const reactDom = join(dir, 'apps/desktop/node_modules/react-dom')
  mkdirSync(react, { recursive: true })
  mkdirSync(reactDom, { recursive: true })
  writeFileSync(join(react, 'package.json'), '{ "name": "react", "version": "0.0.0-stub", "main": "index.js" }')
  writeFileSync(join(react, 'index.js'), REACT_STUB)
  writeFileSync(join(reactDom, 'package.json'), '{ "name": "react-dom", "version": "0.0.0-stub" }')
  writeFileSync(join(reactDom, 'server.js'), REACT_DOM_SERVER_STUB)
}

// budget: an object (serialized), a raw string (for the invalid-JSON case), or
// null to omit the file entirely. desktop/react toggle the two prerequisites.
function fixture({ budget = { cells: 2500, runs: 5, medianBudgetMs: 100000 }, desktop = true, react = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-perfgate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (desktop) {
    mkdirSync(join(dir, 'apps/desktop'), { recursive: true })
    writeFileSync(join(dir, 'apps/desktop/package.json'), '{ "name": "desktop" }')
    if (react) plantReactStub(dir)
  }
  if (budget !== null) {
    const body = typeof budget === 'string' ? budget : JSON.stringify(budget)
    writeFileSync(join(dir, 'tools/perf-budget.json'), body)
  }
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: a generous budget passes, reporting median-of-N (SIDE from cells, one sample per run)', () => {
  const r = runGate(fixture({ budget: { cells: 2500, runs: 5, medianBudgetMs: 100000 } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('perf-budget: OK'), r.out)
  // SIDE = round(sqrt(2500)) = 50; runs = 5.
  assert.ok(r.out.includes('50×50 cells, 5 runs:'), r.out)
  assert.ok(r.out.includes('budget 100000ms'), r.out)
  // Under budget → measured exactly once, no re-measure suffix.
  assert.ok(!r.out.includes('re-measured'), r.out)
  // Median-of-N proof: the detail lists one timing sample per run.
  const samples = r.out.match(/samples ([\d/]+)ms/)
  assert.ok(samples, r.out)
  assert.equal(samples[1].split('/').length, 5, r.out)
})

test('RED: a sub-microsecond medianBudgetMs reds (measurement path can fail) AND re-measures once first', () => {
  const r = runGate(fixture({ budget: { cells: 2500, runs: 5, medianBudgetMs: 0.001 } }))
  assert.equal(r.code, 1, r.out)
  // Re-measure-once proof: a real over-budget median triggers a second full
  // measure before the gate reds ("twice in a row").
  assert.ok(r.out.includes('(re-measured once)'), r.out)
  assert.ok(r.out.includes('regressed past the budget twice in a row'), r.out)
  assert.ok(r.out.includes('budget 0.001ms'), r.out)
})

test('RED: a budget missing any of cells / runs / medianBudgetMs fails naming all three keys', () => {
  for (const drop of ['cells', 'runs', 'medianBudgetMs']) {
    const budget = { cells: 2500, runs: 5, medianBudgetMs: 100 }
    delete budget[drop]
    const r = runGate(fixture({ budget }))
    assert.equal(r.code, 1, `${drop}: ${r.out}`)
    assert.ok(
      r.out.includes('must carry positive numbers for cells, runs, medianBudgetMs'),
      `${drop}: ${r.out}`,
    )
  }
})

test('RED: non-numeric / zero / negative budget values each fail the positive-number guard', () => {
  const bad = [
    { cells: '2500', runs: 5, medianBudgetMs: 100 },
    { cells: 2500, runs: 5, medianBudgetMs: '100' },
    { cells: 0, runs: 5, medianBudgetMs: 100 },
    { cells: 2500, runs: -1, medianBudgetMs: 100 },
    { cells: 2500, runs: 5, medianBudgetMs: null },
  ]
  for (const budget of bad) {
    const r = runGate(fixture({ budget }))
    assert.equal(r.code, 1, JSON.stringify(budget) + ' :: ' + r.out)
    assert.ok(
      r.out.includes('must carry positive numbers for cells, runs, medianBudgetMs'),
      JSON.stringify(budget) + ' :: ' + r.out,
    )
  }
})

test('RED: invalid JSON fails loud, never open', () => {
  const r = runGate(fixture({ budget: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is not valid JSON'), r.out)
})

test('RED: a desktop surface with no committed budget file fails', () => {
  const r = runGate(fixture({ budget: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('perf-budget.json missing'), r.out)
})

test('skip asymmetry: react unresolvable → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  // Valid budget + a desktop surface, but no node_modules planted: the gate
  // clears the shape guards, then can't require react from apps/desktop.
  const dir = fixture({ react: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('react/react-dom not resolvable'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('react/react-dom not resolvable'), ci.out)
})

test('skip asymmetry: no desktop surface → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = fixture({ desktop: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('apps/desktop not found'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

test('the SHIPPED tools/perf-budget.json satisfies the gate shape it is measured against', () => {
  const budget = JSON.parse(readFileSync(SHIPPED_BUDGET_PATH, 'utf8'))
  for (const key of ['cells', 'runs', 'medianBudgetMs']) {
    assert.equal(typeof budget[key], 'number', `${key}: ${JSON.stringify(budget)}`)
    assert.ok(budget[key] > 0, `${key}: ${JSON.stringify(budget)}`)
  }
})

// ---- v0.1.4: real-subject path (budget.subject) ---------------------------------
// The gate's subject branch spawns `pnpm --filter desktop exec tsx` on the real
// TS perfSubject — that end-to-end path needs a full pnpm install, so it is proven
// in the scaffold acceptance (node tools/validate.mjs), not here. Install-free, we
// pin: (a) subject declared but the file is missing → a named FAIL BEFORE any
// spawn; (b) subject present but the spawn cannot run → a named FAIL that says it
// never falls back to the synthetic path; and (c) the anti-vacuity + JSON contract
// of tools/lib/perf-subject-cli.mjs, driven directly under plain node with a .mjs
// subject stub (the CLI imports only node builtins).

test('RED: a declared subject whose file is missing fails BEFORE spawning, naming it', () => {
  const budget = {
    cells: 100,
    runs: 3,
    medianBudgetMs: 500,
    subject: 'apps/desktop/src/features/matrix/perfSubject.ts',
  }
  // Default fixture creates apps/desktop but not the subject file.
  const r = runGate(fixture({ budget }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('budget.subject'), r.out)
  assert.ok(r.out.includes('does not exist'), r.out)
  assert.ok(r.out.includes('apps/desktop/src/features/matrix/perfSubject.ts'), r.out)
})

test('RED: a present subject whose measurement spawn fails is a FAIL, never a synthetic fallback', () => {
  const budget = {
    cells: 100,
    runs: 3,
    medianBudgetMs: 500,
    subject: 'apps/desktop/src/features/matrix/perfSubject.ts',
  }
  const dir = fixture({ budget })
  // Plant the subject so the existence check passes; the spawn then fails because
  // this bare tmp tree is no pnpm workspace (proves no silent synthetic fallback).
  mkdirSync(join(dir, 'apps/desktop/src/features/matrix'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/desktop/src/features/matrix/perfSubject.ts'),
    'export function renderSubject() { return \'<span role="gridcell">x</span>\' }\n',
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('never falls back to a synthetic measurement'), r.out)
  // Never the synthetic detail line.
  assert.ok(!/\d+×\d+ cells/.test(r.out), r.out)
})

const CLI = fileURLToPath(
  new URL('../../template/base/tools/lib/perf-subject-cli.mjs', import.meta.url),
)
function runCli(subjectSource, cells, runs) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-perfcli-'))
  const subj = join(dir, 'subject.mjs')
  writeFileSync(subj, subjectSource)
  const res = spawnSync('node', [CLI, subj, String(cells), String(runs)], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, stdout: res.stdout ?? '' }
}

test('perf-subject-cli: a valid subject prints ONE {"samples":[…]} line of N numbers', () => {
  const src =
    'export function renderSubject(cells) { return `<span role="gridcell">${cells}</span>` }\n'
  const r = runCli(src, 100, 5)
  assert.equal(r.code, 0, r.out)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, r.out) // exactly one line
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.samples.length, 5, r.out)
  assert.ok(
    parsed.samples.every((s) => typeof s === 'number' && Number.isFinite(s)),
    r.out,
  )
})

test('perf-subject-cli: a render without role="gridcell" exits 1 (anti-vacuity)', () => {
  const r = runCli('export function renderSubject() { return "<div>nothing</div>" }\n', 100, 3)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous'), r.out)
})

test('perf-subject-cli: a subject with no renderSubject export exits 1', () => {
  const r = runCli('export const nope = 1\n', 100, 3)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('renderSubject'), r.out)
})
