// Contract tests for template/base/tools/lib/gate.mjs: the FIX[gate] feedback
// line on every failure path (D1 — an agent reading a red Stop block gets the
// exact reproduce command), and the content-addressed stamp machinery (C10 —
// stale-pass prevention is the whole risk of stamping, so invalidation is
// asserted per declared input class).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STAMP_INPUTS } from '../../template/base/tools/lib/stamp-inputs.mjs'

const GATE_LIB = pathToFileURL(
  fileURLToPath(new URL('../../template/base/tools/lib/gate.mjs', import.meta.url)),
).href

function runInFixture(script, { env = {}, cwd } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'tpah-gatelib-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  const file = join(dir, 'tools', 'check-fake.mjs')
  writeFileSync(file, `import { fail, failures, ok, skipOrFail, stampGate } from '${GATE_LIB}'\n${script}`)
  const res = spawnSync('node', [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '', ...env } })
  return { dir, code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('fail() emits the FIX[gate] line with the exact reproduce command', () => {
  const r = runInFixture(`fail('fake', 'boom')`)
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('fake: FAIL — boom'), r.out)
  assert.ok(r.out.includes('FIX[fake]: reproduce with `node tools/check-fake.mjs`'), r.out)
  assert.ok(r.out.includes('docs/harness/gates-catalog.md ("fake")'), r.out)
})

test('failures() and CI-mode skipOrFail() emit the FIX line; local skip does not', () => {
  const lists = runInFixture(`failures('fake', ['a', 'b'], 'hint line')`)
  assert.equal(lists.code, 1)
  assert.ok(lists.out.includes('hint line'), lists.out)
  assert.ok(lists.out.includes('FIX[fake]:'), lists.out)

  const ciSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`, { env: { CI: 'true' } })
  assert.equal(ciSkip.code, 1)
  assert.ok(ciSkip.out.includes('FIX[fake]:'), ciSkip.out)

  const localSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`)
  assert.equal(localSkip.code, 0)
  assert.ok(localSkip.out.includes('SKIPPED'), localSkip.out)
  assert.ok(!localSkip.out.includes('FIX['), localSkip.out)
})

test('every shipped gate script routes failures through lib/gate.mjs (the FIX contract)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const toolsDir = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
  const gateScripts = readdirSync(toolsDir).filter((f) => /^(check-.*|run-rust-gates)\.mjs$/.test(f))
  assert.ok(gateScripts.length >= 12, `expected the gate fleet, got ${gateScripts.length}`)
  for (const f of gateScripts) {
    const src = readFileSync(join(toolsDir, f), 'utf8')
    assert.match(src, /from '\.\/lib\/gate\.mjs'/, `${f} must use lib/gate.mjs so every failure carries the FIX[gate] line`)
    assert.ok(!/process\.exit\(1\)/.test(src), `${f} must not exit(1) directly — use fail()/failures()/skipOrFail()`)
  }
})

const STAMP_SCRIPT = `
const recordGreen = stampGate('fake', ['input.txt'])
recordGreen()
ok('fake', 'ran the real check')
`

test('stampGate: green run stamps; unchanged inputs skip; mutation re-runs; CI ignores stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-stamp-'))
  writeFileSync(join(dir, 'input.txt'), 'v1\n')

  const first = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(first.code, 0)
  assert.ok(first.out.includes('ran the real check'), first.out)

  const second = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(second.code, 0)
  assert.ok(second.out.includes('inputs unchanged since last green run'), second.out)

  writeFileSync(join(dir, 'input.txt'), 'v2\n')
  const third = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.ok(third.out.includes('ran the real check'), third.out)

  const inCi = runInFixture(STAMP_SCRIPT, { cwd: dir, env: { CI: 'true' } })
  assert.ok(inCi.out.includes('ran the real check'), `CI must never trust a stamp: ${inCi.out}`)
})

test('every declared stamp input class invalidates the digest (no stale-pass class)', async () => {
  const { hashInputs } = await import(GATE_LIB)
  for (const [gate, inputs] of Object.entries(STAMP_INPUTS)) {
    const dir = mkdtempSync(join(tmpdir(), 'tpah-inputs-'))
    const prev = process.cwd()
    process.chdir(dir)
    try {
      // materialize a representative file for each declared input path
      for (const p of inputs) {
        if (/\.[a-z0-9]+$/i.test(p)) {
          mkdirSync(join(dir, p, '..'), { recursive: true })
          writeFileSync(join(dir, p), 'seed\n')
        } else {
          mkdirSync(join(dir, p), { recursive: true })
          writeFileSync(join(dir, p, 'file.txt'), 'seed\n')
        }
      }
      const base = hashInputs(inputs)
      for (const p of inputs) {
        const target = /\.[a-z0-9]+$/i.test(p) ? join(dir, p) : join(dir, p, 'file.txt')
        writeFileSync(target, 'mutated\n')
        const now = hashInputs(inputs)
        assert.notEqual(now, base, `${gate}: mutating ${p} must invalidate the stamp digest`)
        writeFileSync(target, 'seed\n')
        assert.equal(hashInputs(inputs), base, `${gate}: restoring ${p} must restore the digest`)
      }
    } finally {
      process.chdir(prev)
    }
  }
})
