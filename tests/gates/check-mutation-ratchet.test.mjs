// Can-fail proofs for the mutation ratchet (template/modules/mutation/tools/
// check-mutation-ratchet.mjs): set-based compare of surviving mutants against a
// committed baseline — pure JSON, no stryker needed to test the machinery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../../template/modules/mutation/tools/check-mutation-ratchet.mjs', import.meta.url),
)
const GATE_LIB_DIR = fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url))

const REPORT = {
  files: {
    'apps/server/src/errors.ts': {
      mutants: [
        { status: 'Survived', mutatorName: 'ConditionalExpression', replacement: 'true', location: { start: { line: 10, column: 3 } } },
        { status: 'Killed', mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 4, column: 1 } } },
      ],
    },
  },
}
const SURVIVOR_KEY = 'apps/server/src/errors.ts:10:3 ConditionalExpression → "true"'

function fixture({ report = REPORT, baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-ratchet-'))
  mkdirSync(join(dir, 'reports/mutation'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  // the script imports ./lib/gate.mjs relative to its installed tools/ home
  cpSync(GATE_LIB_DIR, join(dir, 'tools/lib'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'tools/check-mutation-ratchet.mjs'))
  if (report !== null) writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify(report))
  if (baseline !== undefined) writeFileSync(join(dir, 'tools/mutation-baseline.json'), JSON.stringify(baseline))
  return dir
}

function run(dir, args = []) {
  const res = spawnSync('node', ['tools/check-mutation-ratchet.mjs', ...args], { cwd: dir, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: survivors exactly match the committed baseline', () => {
  const r = run(fixture({ baseline: { survivors: [SURVIVOR_KEY] } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('within the committed baseline'), r.out)
})

test('RED: a NEW survivor outside the baseline names the mutant', () => {
  const r = run(fixture({ baseline: { survivors: [] } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('NEW surviving mutant'), r.out)
  assert.ok(r.out.includes(SURVIVOR_KEY), r.out)
  assert.ok(r.out.includes('FIX[mutation-ratchet]'), r.out)
})

test('GREEN + tighten hint: a baseline survivor that no longer survives', () => {
  const r = run(fixture({ baseline: { survivors: [SURVIVOR_KEY, 'packages/eval/src/score.ts:1:1 Gone → "x"'] } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('no longer survive'), r.out)
  assert.ok(r.out.includes('ready to ratchet out'), r.out)
})

test('RED: missing report, missing baseline, malformed baseline all fail loud', () => {
  const noReport = run(fixture({ report: null, baseline: { survivors: [] } }))
  assert.equal(noReport.code, 1, noReport.out)
  assert.ok(noReport.out.includes('reports/mutation/mutation.json missing'), noReport.out)

  const noBaseline = run(fixture({}))
  assert.equal(noBaseline.code, 1, noBaseline.out)
  assert.ok(noBaseline.out.includes('--write'), noBaseline.out)

  const dir = fixture({})
  writeFileSync(join(dir, 'tools/mutation-baseline.json'), '{nope')
  const bad = run(dir)
  assert.equal(bad.code, 1, bad.out)
  assert.ok(bad.out.includes('not valid JSON'), bad.out)
})

test('--write seeds the baseline from the current report (reviewed decision)', () => {
  const dir = fixture({})
  const w = run(dir, ['--write'])
  assert.equal(w.code, 0, w.out)
  const baseline = JSON.parse(readFileSync(join(dir, 'tools/mutation-baseline.json'), 'utf8'))
  assert.deepEqual(baseline.survivors, [SURVIVOR_KEY])
  // and the ratchet is green immediately after
  assert.equal(run(dir).code, 0)
})
