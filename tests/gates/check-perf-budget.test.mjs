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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
/** @param {{ budget?: any, desktop?: boolean, react?: boolean }} [opts] */
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

/** @param {string} dir @param {{ ci?: boolean, extraEnv?: Record<string, string> }} [opts] */
function runGate(dir, { ci = true, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.PERF_SUBJECT_EXPECT
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ---- subjects[]-shape helpers (v0.1.5) -------------------------------------------
const MATRIX_SUBJECT = 'apps/desktop/src/features/matrix/perfSubject.ts'

function plantFile(dir, rel, content) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true })
  writeFileSync(join(dir, rel), content)
}

// A minimal subjects[]-shape budget: one matrix entry under a generous budget.
/** @param {Record<string, any>} [overrides] */
function subjectsBudget(overrides = {}) {
  return {
    runs: 3,
    subjects: [{ subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 100000 }],
    ...overrides,
  }
}

// A file whose import makes its feature dir "dense" to the closure scan.
const DENSE_FEATURE_SOURCE =
  "import { computeWindow } from '../matrix/useVirtualWindow'\nexport const w = computeWindow\n"

// A POSIX `pnpm` shim on PATH standing in for `pnpm --filter desktop exec tsx …`:
// prints one {"samples":[…]} line exactly like the real perf-subject CLI would.
// requireExpect pins the gate→CLI anti-vacuity contract: the shim refuses to
// "measure" unless PERF_SUBJECT_EXPECT arrives with exactly that value.
/** @param {string} dir @param {{ samples?: number[], requireExpect?: string }} [opts] */
function fakePnpm(dir, { samples = [1, 1, 1], requireExpect } = {}) {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  const guard =
    requireExpect === undefined
      ? ''
      : `[ "$PERF_SUBJECT_EXPECT" = '${requireExpect}' ] || { echo "PERF_SUBJECT_EXPECT not passed through" >&2; exit 1; }\n`
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\n${guard}echo '${JSON.stringify({ samples })}'\nexit 0\n`,
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  return bin
}

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX-only pnpm shim' : false }

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

test('the SHIPPED tools/perf-budget.json declares the subjects[] shape the gate enforces', () => {
  const budget = JSON.parse(readFileSync(SHIPPED_BUDGET_PATH, 'utf8'))
  assert.equal(typeof budget.runs, 'number', JSON.stringify(budget))
  assert.ok(budget.runs > 0, JSON.stringify(budget))
  assert.equal(budget.subject, undefined, 'legacy "subject" must not coexist with subjects[]')
  assert.ok(Array.isArray(budget.subjects) && budget.subjects.length >= 1, JSON.stringify(budget))
  const matrix = budget.subjects.find((s) => s.subject === MATRIX_SUBJECT)
  assert.ok(matrix, `the matrix exemplar must stay declared: ${JSON.stringify(budget.subjects)}`)
  for (const entry of budget.subjects) {
    assert.equal(typeof entry.subject, 'string', JSON.stringify(entry))
    assert.ok(entry.cells > 0, JSON.stringify(entry))
    assert.ok(entry.medianBudgetMs > 0, JSON.stringify(entry))
  }
  assert.ok(Array.isArray(budget.exempt), 'exempt must ship as a (possibly empty) array')
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
/** @param {string} subjectSource @param {number} cells @param {number} runs @param {{ expect?: string }} [opts] */
function runCli(subjectSource, cells, runs, { expect, markerScales } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-perfcli-'))
  const subj = join(dir, 'subject.mjs')
  writeFileSync(subj, subjectSource)
  const env = { ...process.env }
  delete env.PERF_SUBJECT_EXPECT
  delete env.PERF_SUBJECT_MARKER_SCALES
  if (expect !== undefined) env.PERF_SUBJECT_EXPECT = expect
  if (markerScales === false) env.PERF_SUBJECT_MARKER_SCALES = '0'
  const res = spawnSync('node', [CLI, subj, String(cells), String(runs)], { encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, stdout: res.stdout ?? '' }
}

test('perf-subject-cli: a valid subject prints ONE {"samples":[…]} line of N numbers', () => {
  // A REAL subject renders one marker per declared cell — the G30 scale check demands it.
  const src =
    'export function renderSubject(cells) { return \'<span role="gridcell">x</span>\'.repeat(cells) }\n'
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

test('perf-subject-cli: PERF_SUBJECT_EXPECT overrides the anti-vacuity marker per subject', () => {
  const src =
    'export function renderSubject(cells) { return \'<div data-heatcell="1">x</div>\'.repeat(cells) }\n'
  // The custom marker is present (and scales) → green even though role="gridcell" is absent.
  const hit = runCli(src, 100, 3, { expect: 'data-heatcell' })
  assert.equal(hit.code, 0, hit.out)
  // No override → the gridcell default still applies to the same render.
  const miss = runCli(src, 100, 3)
  assert.equal(miss.code, 1, miss.out)
  assert.ok(miss.out.includes('role="gridcell"'), miss.out)
  // Override present but not in the HTML → red NAMING the marker.
  const wrong = runCli(src, 100, 3, { expect: 'role="row"' })
  assert.equal(wrong.code, 1, wrong.out)
  assert.ok(wrong.out.includes('expected marker role="row"'), wrong.out)
  assert.ok(wrong.out.includes('vacuous'), wrong.out)
})

// ---- v0.1.6 (G30): PRESENCE was never enough — the work must SCALE with `cells` ----
test('perf-subject-cli: a subject whose markers do NOT scale with cells exits 1 (G30)', () => {
  // The exact green-but-bad path: ONE gridcell still satisfies the presence check, so the
  // budget "passed" in ~1 ms while measuring essentially nothing. A regression could be
  // hidden simply by shrinking what gets measured.
  const src =
    'export function renderSubject() { return \'<span role="gridcell">only one</span>\' }\n'
  const r = runCli(src, 10000, 3)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not scale with the declared work'), r.out)
  assert.ok(r.out.includes('10000'), r.out)
})

test('perf-subject-cli: markerScales=false is the reviewed opt-out for a container marker', () => {
  const src = 'export function renderSubject() { return \'<div data-chart="1">x</div>\' }\n'
  const r = runCli(src, 10000, 3, { expect: 'data-chart', markerScales: false })
  assert.equal(r.code, 0, r.out)
})

// ---- v0.1.5: subjects[] shape + dense-feature closure ----------------------------
// Closure and shape validation run BEFORE any measurement spawn, so every red
// below is proven install-free; the measurement loop itself is pinned with a
// POSIX pnpm shim (the check-e2e.test.mjs pattern) and end-to-end in the
// fresh-scaffold acceptance lane.

test('RED: declaring BOTH "subject" and "subjects" is an ambiguity fail, never a guess', () => {
  const r = runGate(
    fixture({ budget: { runs: 3, subject: MATRIX_SUBJECT, subjects: [] } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('BOTH "subject" and "subjects"'), r.out)
  assert.ok(r.out.includes('delete the legacy "subject" key'), r.out)
})

test('RED: subjects[] shape violations each fail closed naming the contract', () => {
  const cases = [
    { runs: 3, subjects: {} }, // not an array
    { runs: 3, subjects: [] }, // empty = vacuous measurement list
    { runs: 3, subjects: [{ subject: MATRIX_SUBJECT, cells: 100 }] }, // no budget
    { runs: 3, subjects: [{ subject: MATRIX_SUBJECT, cells: -1, medianBudgetMs: 5 }] },
    { runs: 3, subjects: [{ subject: '', cells: 100, medianBudgetMs: 5 }] },
    { runs: 3, subjects: [{ subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 5, expect: '' }] },
  ]
  for (const budget of cases) {
    const r = runGate(fixture({ budget }))
    assert.equal(r.code, 1, `${JSON.stringify(budget)} :: ${r.out}`)
    assert.ok(
      r.out.includes('"subject": non-empty string') || r.out.includes('NON-EMPTY array'),
      `${JSON.stringify(budget)} :: ${r.out}`,
    )
  }
  const noRuns = runGate(fixture({ budget: { subjects: [{ subject: MATRIX_SUBJECT, cells: 1, medianBudgetMs: 1 }] } }))
  assert.equal(noRuns.code, 1, noRuns.out)
  assert.ok(noRuns.out.includes('positive number for runs'), noRuns.out)
})

test('RED: a duplicate subjects[] entry fails naming the path', () => {
  const entry = { subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 5 }
  const r = runGate(fixture({ budget: { runs: 3, subjects: [entry, { ...entry }] } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('twice'), r.out)
  assert.ok(r.out.includes(MATRIX_SUBJECT), r.out)
})

test('RED closure: a dense feature (imports useVirtualWindow) without perfSubject.ts, with the create-FIX line', () => {
  const dir = fixture({ budget: subjectsBudget() })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  plantFile(dir, 'apps/desktop/src/features/reports/HeatPanel.tsx', DENSE_FEATURE_SOURCE)
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ships NO perfSubject.ts'), r.out)
  // The FIX line says exactly what to create and points at the worked pattern.
  assert.ok(r.out.includes('apps/desktop/src/features/reports/perfSubject.ts'), r.out)
  assert.ok(r.out.includes('renderSubject(cells)'), r.out)
  assert.ok(r.out.includes('worked pattern: apps/desktop/src/features/matrix/perfSubject.ts'), r.out)
  assert.ok(r.out.includes('exempt'), r.out)
  // Closure reds BEFORE any measurement spawn.
  assert.ok(!r.out.includes('falls back'), r.out)
})

test('RED closure: useRovingGrid imports are detected too, tolerant of path variants', () => {
  const dir = fixture({ budget: subjectsBudget() })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  plantFile(
    dir,
    'apps/desktop/src/features/triage/Grid.tsx',
    "import { useRovingGrid } from '@/features/matrix/useRovingGrid'\nexport const g = useRovingGrid\n",
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/desktop/src/features/triage/'), r.out)
  assert.ok(r.out.includes('ships NO perfSubject.ts'), r.out)
})

test('RED closure (inverse): a subjects[] entry pointing at a missing file fails before any spawn', () => {
  const r = runGate(fixture({ budget: subjectsBudget() })) // matrix file never planted
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`subjects[] declares "${MATRIX_SUBJECT}" but the file does not exist`), r.out)
  assert.ok(r.out.includes('remove the entry'), r.out)
  assert.ok(!r.out.includes('falls back'), r.out)
})

test('RED closure (inverse): an existing features/*/perfSubject.ts not declared in subjects[] fails', () => {
  const dir = fixture({ budget: subjectsBudget() })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  plantFile(dir, 'apps/desktop/src/features/notes/perfSubject.ts', 'export function renderSubject() { return "" }\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('apps/desktop/src/features/notes/perfSubject.ts exists but is not declared'),
    r.out,
  )
})

test('RED: malformed exempt entries fail closed, never fail open', () => {
  const missingReason = runGate(
    fixture({ budget: subjectsBudget({ exempt: [{ dir: 'reports' }] }) }),
  )
  assert.equal(missingReason.code, 1, missingReason.out)
  assert.ok(missingReason.out.includes('every exemption must be'), missingReason.out)
  const notArray = runGate(fixture({ budget: subjectsBudget({ exempt: 'reports' }) }))
  assert.equal(notArray.code, 1, notArray.out)
  assert.ok(notArray.out.includes('"exempt" must be an ARRAY'), notArray.out)
  const pathNotName = runGate(
    fixture({ budget: subjectsBudget({ exempt: [{ dir: 'apps/desktop/src/features/reports', reason: 'x' }] }) }),
  )
  assert.equal(pathNotName.code, 1, pathNotName.out)
  assert.ok(pathNotName.out.includes('feature dir NAME'), pathNotName.out)
})

test('RED: a stale exemption (no such feature dir) fails — the escape list stays honest', () => {
  const dir = fixture({ budget: subjectsBudget({ exempt: [{ dir: 'ghost', reason: 'gone' }] }) })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('exempts feature dir "ghost"'), r.out)
  assert.ok(r.out.includes('stale exemption'), r.out)
})

test(
  'GREEN: exempt silences a dense dir; the default expect marker reaches the CLI via env',
  POSIX_ONLY,
  () => {
    const dir = fixture({
      budget: subjectsBudget({ exempt: [{ dir: 'reports', reason: 'prototype, not routed yet' }] }),
    })
    plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
    plantFile(dir, 'apps/desktop/src/features/reports/HeatPanel.tsx', DENSE_FEATURE_SOURCE)
    // The shim only "measures" when PERF_SUBJECT_EXPECT carries the gridcell
    // default — proof the gate always arms the anti-vacuity marker on this path.
    const bin = fakePnpm(dir, { requireExpect: 'role="gridcell"' })
    const r = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.includes('perf-budget: OK'), r.out)
    assert.ok(r.out.includes(`subject ${MATRIX_SUBJECT}, 100 cells, 3 runs`), r.out)
    assert.ok(!r.out.includes('NOTE'), r.out)
  },
)

test('GREEN: multiple subjects are measured sequentially, one detail per entry', POSIX_ONLY, () => {
  const second = 'apps/desktop/src/features/reports/perfSubject.ts'
  const dir = fixture({
    budget: {
      runs: 3,
      subjects: [
        { subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 100000 },
        { subject: second, cells: 40, medianBudgetMs: 100000 },
      ],
    },
  })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  plantFile(dir, second, 'export function renderSubject() { return "" }\n')
  plantFile(dir, 'apps/desktop/src/features/reports/HeatPanel.tsx', DENSE_FEATURE_SOURCE)
  const bin = fakePnpm(dir)
  const r = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`subject ${MATRIX_SUBJECT}, 100 cells, 3 runs`), r.out)
  assert.ok(r.out.includes(`subject ${second}, 40 cells, 3 runs`), r.out)
})

test('per-subject expect: a declared marker is passed through and its absence would red', POSIX_ONLY, () => {
  const dir = fixture({
    budget: {
      runs: 3,
      subjects: [{ subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 100000, expect: 'data-heatcell' }],
    },
  })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  const bin = fakePnpm(dir, { requireExpect: 'data-heatcell' })
  const green = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
  assert.equal(green.code, 0, green.out)
  // Control: the same shim guard with the DEFAULT marker exits 1, and the gate
  // reports the measurement failure — the env contract is load-bearing.
  const dir2 = fixture({ budget: subjectsBudget() })
  plantFile(dir2, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  const bin2 = fakePnpm(dir2, { requireExpect: 'data-heatcell' })
  const red = runGate(dir2, { ci: false, extraEnv: { PATH: `${bin2}:${process.env.PATH}` } })
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('failed to measure'), red.out)
})

test('RED: an over-budget subjects[] median re-measures once, then fails naming the subject', POSIX_ONLY, () => {
  const dir = fixture({
    budget: { runs: 3, subjects: [{ subject: MATRIX_SUBJECT, cells: 100, medianBudgetMs: 1 }] },
  })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  const bin = fakePnpm(dir, { samples: [999, 999, 999] })
  const r = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('(re-measured once)'), r.out)
  assert.ok(r.out.includes('regressed past the budget twice in a row'), r.out)
  assert.ok(r.out.includes(`subject ${MATRIX_SUBJECT}`), r.out)
})

// ---- v0.1.5: legacy-shape NOTE (content-conditional, not rampNote) ---------------

test('NOTE: the legacy single-subject shape names the subjects[] form and the refresh command', () => {
  const budget = { cells: 100, runs: 3, medianBudgetMs: 500, subject: MATRIX_SUBJECT }
  const r = runGate(fixture({ budget })) // subject file missing → red AFTER the NOTE
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('perf-budget: NOTE'), r.out)
  assert.ok(r.out.includes('legacy single-subject shape'), r.out)
  assert.ok(r.out.includes('subjects: [{ subject, cells, medianBudgetMs }]'), r.out)
  assert.ok(r.out.includes('update --refresh-seeded tools/perf-budget.json'), r.out)
})

test('legacy single-subject GREEN behavior is unchanged apart from the NOTE', POSIX_ONLY, () => {
  const budget = { cells: 100, runs: 3, medianBudgetMs: 100000, subject: MATRIX_SUBJECT }
  const dir = fixture({ budget })
  plantFile(dir, MATRIX_SUBJECT, 'export function renderSubject() { return "" }\n')
  const bin = fakePnpm(dir)
  const r = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('perf-budget: NOTE'), r.out)
  assert.ok(r.out.includes(`OK — subject ${MATRIX_SUBJECT}, 100 cells, 3 runs`), r.out)
})

test('no NOTE on the subject-absent synthetic shape (pre-0.1.4 budgets stay byte-quiet)', () => {
  const r = runGate(fixture({ budget: { cells: 100, runs: 3, medianBudgetMs: 100000 } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes('NOTE'), r.out)
})
