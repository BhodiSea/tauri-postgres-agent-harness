// Behavioral tests for template/base/tools/validate.mjs: default first-failure
// stop vs --report-all (the Stop hook path must surface EVERY red at once), and
// per-step elapsed-ms in the summary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VALIDATE = fileURLToPath(new URL('../../template/base/tools/validate.mjs', import.meta.url))

// Stub config: red, green, red — distinguishes "stopped at first failure" from
// "ran everything" unambiguously.
const STUB_CONFIG = `export const VALIDATE_STEPS = [
  ['first-red', 'node -e "process.exit(1)"'],
  ['mid-green', 'node -e "process.exit(0)"'],
  ['last-red', 'node -e "process.exit(1)"'],
]
export const STOP_HOOK_STEPS = []
`

function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-validate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  copyFileSync(VALIDATE, join(dir, 'tools/validate.mjs'))
  writeFileSync(join(dir, 'tools/harness.config.mjs'), STUB_CONFIG)
  const res = spawnSync('node', ['tools/validate.mjs', ...args], { cwd: dir, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('default run stops at the first failure and says what did not run', () => {
  const r = run([])
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('✗ first-red'), r.out)
  assert.ok(!r.out.includes('mid-green ('), r.out)
  assert.ok(r.out.includes('(2 later step(s) not run)'), r.out)
})

test('--report-all runs every step, reports every red, still exits 1', () => {
  const r = run(['--report-all'])
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('✗ first-red'), r.out)
  assert.ok(r.out.includes('✓ mid-green'), r.out)
  assert.ok(r.out.includes('✗ last-red'), r.out)
  assert.ok(!r.out.includes('not run'), r.out)
})

test('summary carries per-step elapsed ms and a total', () => {
  const r = run(['--report-all'])
  assert.match(r.out, /✓ mid-green \(\d+ms\)/, r.out)
  assert.match(r.out, /total \d+ms/, r.out)
})
