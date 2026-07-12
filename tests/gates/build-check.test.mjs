// Fixture proofs for the build gate's gzip RATCHET (template/base/tools/
// build-check.mjs + the shared measurer tools/lib/bundle-measure.mjs):
//   - a committed tools/perf-baseline.json with a tiny total → RED naming
//     measured vs baseline × ratioCap and the `pnpm perf:baseline` ceremony;
//   - exactly AT the cap → GREEN (the ratchet fails on strict growth only);
//   - absent baseline → NOTE naming the file + command, absolute budgets keep
//     their 0.1.4 behavior; malformed baseline → fail closed, never open;
//   - the shared lib measures deterministically, keys chunks by their
//     hash-stripped logical name, and the regenerator's compose/serialize path
//     writes sorted, byte-stable output (no real vite build anywhere here: the
//     gate's `pnpm … vite build` is stood in by a POSIX shim, dist is a fixture
//     tree — the injections.json registry references these cases by file).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  composeBaseline,
  diffBaseline,
  measureDist,
  parseBaseline,
  ratchetFindings,
  serializeBaseline,
} from '../../template/base/tools/lib/bundle-measure.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX-only pnpm shim' : false

// A dist tree with stable contents: one hashed entry chunk, one hashed lazy
// chunk, one hashed css asset, index.html. Gzip sizes are computed with the
// same zlib the lib uses, so expectations never drift from the environment.
const DIST_FILES = {
  'index.html': '<!doctype html><html><head></head><body>fixture</body></html>\n',
  'assets/index-AbCdEf12.js': `console.log(${JSON.stringify('main bundle payload '.repeat(40))})\n`,
  'assets/MatrixScreen-Zz99Yy88.js': `console.log(${JSON.stringify('lazy matrix chunk '.repeat(20))})\n`,
  'assets/index-C1MSdlGh.css': `.canvas{color:oklch(0.16 0.006 240)}${'/* pad */'.repeat(30)}\n`,
}
const gz = (content) => gzipSync(Buffer.from(content)).length
const TOTAL = Object.values(DIST_FILES).reduce((sum, c) => sum + gz(c), 0)
const MAIN_CHUNK = gz(DIST_FILES['assets/index-AbCdEf12.js'])
const LAZY_CHUNK = gz(DIST_FILES['assets/MatrixScreen-Zz99Yy88.js'])

const GENEROUS_BUDGET = { totalGzipKb: 250, largestChunkGzipKb: 180, largestAssetGzipKb: 100 }

/**
 * @param {{ budget?: object | null, baseline?: object | string, dist?: Record<string, string> }} [opts]
 */
function fixture({ budget = GENEROUS_BUDGET, baseline, dist = DIST_FILES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-buildgate-'))
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'build-check.mjs'), join(dir, 'tools/build-check.mjs'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true }) // pass the install probe
  mkdirSync(join(dir, 'apps/desktop/dist'), { recursive: true })
  writeFileSync(join(dir, 'apps/desktop/package.json'), '{"name":"desktop"}\n')
  for (const [rel, content] of Object.entries(dist)) {
    mkdirSync(join(dir, 'apps/desktop/dist', rel, '..'), { recursive: true })
    writeFileSync(join(dir, 'apps/desktop/dist', rel), content)
  }
  if (budget !== null) {
    writeFileSync(join(dir, 'tools/bundle-budget.json'), `${JSON.stringify(budget)}\n`)
  }
  if (baseline !== undefined) {
    const text = typeof baseline === 'string' ? baseline : `${JSON.stringify(baseline)}\n`
    writeFileSync(join(dir, 'tools/perf-baseline.json'), text)
  }
  // POSIX pnpm shim: `pnpm --filter desktop exec vite build` becomes a no-op
  // success, so the gate proceeds to measure the fixture dist.
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  return dir
}

function runGate(dir, { ci = true } = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH ?? ''}` }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [join(dir, 'tools/build-check.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── gate-level ratchet proofs ─────────────────────────────────────────────────
test('RED ratchet: baseline with a tiny total → build fails naming measured, baseline × ratioCap, and the re-baseline ceremony', { skip: POSIX_ONLY }, () => {
  const dir = fixture({ baseline: { gzip: { total: 10 }, ratioCap: 1.25 } })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`bundle total ${TOTAL} B gzip exceeds the committed ratchet`), r.out)
  assert.ok(r.out.includes('baseline 10 B × ratioCap 1.25'), r.out)
  assert.ok(r.out.includes('pnpm perf:baseline'), r.out)
  assert.ok(r.out.includes('reviewed commit'), r.out)
})

test('GREEN exact boundary: measured == baseline × ratioCap passes (strict-growth ratchet)', { skip: POSIX_ONLY }, () => {
  const dir = fixture({ baseline: { gzip: { total: TOTAL }, ratioCap: 1 } })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('build: OK'), r.out)
  // …and one byte less of allowance is the red side of the same boundary.
  const red = runGate(fixture({ baseline: { gzip: { total: TOTAL - 1 }, ratioCap: 1 } }))
  assert.equal(red.code, 1, red.out)
})

test('RED per-chunk ratchet: a declared logical chunk over its cap fails naming the chunk key', { skip: POSIX_ONLY }, () => {
  const dir = fixture({
    baseline: {
      gzip: { total: TOTAL, chunks: { 'MatrixScreen.js': 1 } },
      ratioCap: 1.25,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('chunk "MatrixScreen.js"'), r.out)
  assert.ok(r.out.includes(`${LAZY_CHUNK} B gzip exceeds the committed ratchet`), r.out)
})

test('NOTE, not red: a baseline chunk key the build no longer emits (rename/merge) — total still ratchets', { skip: POSIX_ONLY }, () => {
  const dir = fixture({
    baseline: {
      gzip: { total: TOTAL, chunks: { 'Ghost.js': 123 } },
      ratioCap: 1,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE — baseline chunk "Ghost.js" is no longer emitted'), r.out)
})

test('absent baseline: loud NOTE names tools/perf-baseline.json + pnpm perf:baseline; absolute budgets keep legacy behavior', { skip: POSIX_ONLY }, () => {
  const green = runGate(fixture())
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('NOTE — tools/perf-baseline.json absent'), green.out)
  assert.ok(green.out.includes('pnpm perf:baseline'), green.out)
  // Legacy absolute-cap red is untouched: a tiny totalGzipKb still fails with
  // the 0.1.4 message and no ratchet vocabulary.
  const red = runGate(fixture({ budget: { totalGzipKb: 0.001 } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('KB budget (tools/bundle-budget.json)'), red.out)
  assert.ok(!red.out.includes('committed ratchet'), red.out)
})

test('malformed baseline FAILS CLOSED: invalid JSON and bad shapes both red with the regenerate FIX', { skip: POSIX_ONLY }, () => {
  const cases = [
    ['{ not json', 'is not valid JSON'],
    ['{"ratioCap": 1.25}\n', 'gzip.total'],
    [`${JSON.stringify({ gzip: { total: TOTAL } })}\n`, 'ratioCap'],
    [`${JSON.stringify({ gzip: { total: TOTAL, chunks: { 'index.js': -5 } }, ratioCap: 1.25 })}\n`, 'chunks'],
  ]
  for (const [text, needle] of cases) {
    const r = runGate(fixture({ baseline: text }))
    assert.equal(r.code, 1, `${needle}: ${r.out}`)
    assert.ok(r.out.includes(needle), r.out)
    assert.ok(r.out.includes('FAILS CLOSED'), r.out)
    assert.ok(r.out.includes('pnpm perf:baseline'), r.out)
  }
})

test('purity scan survives the measurement refactor: a connection string in a chunk still reds', { skip: POSIX_ONLY }, () => {
  const dist = {
    ...DIST_FILES,
    'assets/leak-Ab12Cd34.js': 'fetch("postgres://app:secret@db/prod")\n',
  }
  const r = runGate(fixture({ dist }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('connection string in the client bundle'), r.out)
})

// ── stamp: the baseline is a build input ─────────────────────────────────────
test('warm stamp: green run records .harness/build.ok; editing the baseline invalidates the warm skip', { skip: POSIX_ONLY }, () => {
  const dir = fixture({ baseline: { gzip: { total: TOTAL }, ratioCap: 1.25 } })
  const cold = runGate(dir, { ci: false })
  assert.equal(cold.code, 0, cold.out)
  assert.ok(existsSync(join(dir, '.harness/build.ok')), 'green run must record the stamp')
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes('inputs unchanged'), warm.out)
  // Edit the committed baseline: the stamp must invalidate and the gate re-run
  // for real — here the tightened baseline goes RED, proof it re-measured.
  writeFileSync(
    join(dir, 'tools/perf-baseline.json'),
    `${JSON.stringify({ gzip: { total: Math.floor(TOTAL / 2) }, ratioCap: 1 })}\n`,
  )
  const after = runGate(dir, { ci: false })
  assert.equal(after.code, 1, after.out)
  assert.ok(!after.out.includes('inputs unchanged'), after.out)
  assert.ok(after.out.includes('committed ratchet'), after.out)
})

// ── shared measuring lib (pure — no gate spawn, no shim) ─────────────────────
/** @param {Record<string, string>} [files] */
function distFixture(files = DIST_FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-measure-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

test('measureDist: totals sum every emitted file; chunks key JS by hash-stripped logical name; deterministic', () => {
  const dist = distFixture()
  const a = measureDist(dist)
  assert.equal(a.totalBytes, TOTAL)
  assert.deepEqual(a.chunks, { 'index.js': MAIN_CHUNK, 'MatrixScreen.js': LAZY_CHUNK })
  // css/html never enter chunks; every file enters the total.
  assert.equal(a.files.length, 4)
  const b = measureDist(dist)
  assert.deepEqual(b, a, 'same tree must measure identically')
})

test('measureDist: unhashed names pass through; same logical key sums; hash stripping needs the exact 8-char tail', () => {
  const dist = distFixture({
    'vendor.js': 'console.log("no hash")\n',
    'assets/index-AbCdEf12.js': 'console.log("one")\n',
    'nested/index-Zz99Yy88.js': 'console.log("two, same logical key")\n',
    'assets/data-model.js': 'console.log("hyphen but not a hash — key survives whole")\n',
  })
  const m = measureDist(dist)
  assert.deepEqual(Object.keys(m.chunks).sort(), ['data-model.js', 'index.js', 'vendor.js'])
  assert.equal(
    m.chunks['index.js'],
    gz('console.log("one")\n') + gz('console.log("two, same logical key")\n'),
  )
})

test('parseBaseline: accepts the shipped shape; rejects every malformed variant with a named reason', () => {
  const good = parseBaseline(
    JSON.stringify({
      comment: 'x',
      generatedBy: 'pnpm perf:baseline',
      gzip: { chunks: { 'index.js': 10 }, total: 100 },
      installerBudgetBytes: 5,
      ratioCap: 1.25,
    }),
  )
  assert.equal(good.gzip.total, 100)
  /** @type {[string, RegExp][]} */
  const bad = [
    ['nope', /not valid JSON/],
    ['[1]', /JSON object/],
    ['{"gzip":{"total":0},"ratioCap":1.25}', /gzip\.total/],
    ['{"gzip":{"total":"100"},"ratioCap":1.25}', /gzip\.total/],
    ['{"gzip":{"total":100},"ratioCap":0.9}', /ratioCap >= 1/],
    ['{"gzip":{"total":100,"chunks":[1]},"ratioCap":1.25}', /gzip\.chunks/],
    ['{"gzip":{"total":100,"chunks":{"a.js":0}},"ratioCap":1.25}', /gzip\.chunks\["a\.js"\]/],
    ['{"gzip":{"total":100},"ratioCap":1.25,"installerBudgetBytes":-1}', /installerBudgetBytes/],
  ]
  for (const [text, re] of bad) {
    assert.throws(() => parseBaseline(text), re, text)
  }
})

test('ratchetFindings: strict-growth boundary — at the cap green, one byte over red; missing chunk is a note', () => {
  const baseline = { gzip: { total: 100, chunks: { 'index.js': 40, 'gone.js': 5 } }, ratioCap: 1.25 }
  const atCap = ratchetFindings({ totalBytes: 125, chunks: { 'index.js': 50 } }, baseline)
  assert.deepEqual(atCap.errs, [])
  assert.equal(atCap.notes.length, 1)
  assert.match(atCap.notes[0], /"gone\.js" is no longer emitted/)
  const over = ratchetFindings({ totalBytes: 126, chunks: { 'index.js': 51 } }, baseline)
  assert.equal(over.errs.length, 2)
  assert.match(over.errs[0], /126 B gzip exceeds .* 125 B/)
  assert.match(over.errs[1], /chunk "index\.js": 51 B/)
})

// ── regenerator compose/serialize (what `pnpm perf:baseline` writes) ─────────
test('composeBaseline + serializeBaseline: sorted keys, stable bytes, human-tuned knobs preserved', () => {
  const measured = { totalBytes: 12345, chunks: { 'z.js': 2, 'a.js': 1 }, files: [] }
  const fresh = composeBaseline({ measured, prev: null })
  assert.equal(fresh.generatedBy, 'pnpm perf:baseline')
  assert.equal(fresh.ratioCap, 1.25)
  assert.ok(fresh.installerBudgetBytes > 0)
  const text = serializeBaseline(fresh)
  // Deep-sorted and byte-stable: identical input, identical output; keys in order.
  assert.equal(text, serializeBaseline(composeBaseline({ measured, prev: null })))
  assert.ok(text.endsWith('\n'))
  const keyOrder = [...text.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((m) => m[1])
  assert.deepEqual(keyOrder, ['comment', 'generatedBy', 'gzip', 'installerBudgetBytes', 'ratioCap'])
  assert.ok(text.indexOf('"a.js"') < text.indexOf('"z.js"'), 'chunk keys must serialize sorted')
  // A previous baseline's reviewed policy knobs survive; measured bytes move.
  const prev = { comment: 'tuned', gzip: { total: 1, chunks: {} }, installerBudgetBytes: 777, ratioCap: 2 }
  const next = composeBaseline({ measured, prev })
  assert.equal(next.comment, 'tuned')
  assert.equal(next.installerBudgetBytes, 777)
  assert.equal(next.ratioCap, 2)
  assert.equal(next.gzip.total, 12345)
})

test('diffBaseline: seeding line without a previous baseline; total/chunk deltas against one', () => {
  const measured = { totalBytes: 200, chunks: { 'index.js': 150, 'new.js': 50 }, files: [] }
  const next = composeBaseline({ measured, prev: null })
  assert.match(diffBaseline(null, next)[0], /no previous .*seeding gzip total 200 B/)
  const prev = { gzip: { total: 100, chunks: { 'index.js': 100, 'old.js': 10 } }, ratioCap: 1.25 }
  const lines = diffBaseline(prev, next)
  assert.match(lines[0], /gzip total: 100 B → 200 B \(\+100\.0%\)/)
  assert.ok(lines.some((l) => /chunk "index\.js": 100 B → 150 B/.test(l)), lines.join('|'))
  assert.ok(lines.some((l) => /chunk "new\.js": NEW at 50 B/.test(l)), lines.join('|'))
  assert.ok(lines.some((l) => /chunk "old\.js": REMOVED/.test(l)), lines.join('|'))
})
