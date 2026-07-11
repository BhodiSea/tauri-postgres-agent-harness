// Cheap, install-free RED proofs for the gates that have no dedicated fixture
// suite — every gate in the chain must be provably able to fail (a gate that
// cannot go red is decoration). The canary-coverage checker
// (scripts/check-canary-coverage.mjs) references these by file, so deleting a
// proof breaks the coverage lockstep, not just the safety net.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

function fixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-canary-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

function runGate(script, dir, env = { CI: 'true' }) {
  cpSync(join(TOOLS, script), join(dir, 'tools', script))
  const res = spawnSync('node', [join('tools', script)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('RED version-sync: workspace version drift fails naming both versions', () => {
  const dir = fixture({
    'package.json': '{ "version": "1.0.0" }',
    'apps/server/package.json': '{ "version": "2.0.0" }',
  })
  const r = runGate('check-version-sync.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
})

test('RED prompts: a corrupt lock file fails loud, never open', () => {
  const dir = fixture({ 'tools/prompts.lock.json': '{nope' })
  const r = runGate('check-prompts-lock.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not valid JSON'), r.out)
})

test('RED licenses: CI with no install fails closed (skip is not a pass)', () => {
  const dir = fixture({})
  const r = runGate('check-licenses.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
})

test('RED contracts: CI with an emit script but no install fails closed', () => {
  const dir = fixture({ 'apps/server/scripts/emit-openapi.ts': '// emit' })
  const r = runGate('check-contract-drift.mjs', dir)
  assert.equal(r.code, 1, r.out)
})

test('RED build: CI with a desktop surface but no install fails closed', () => {
  const dir = fixture({ 'apps/desktop/package.json': '{}' })
  const r = runGate('build-check.mjs', dir)
  assert.equal(r.code, 1, r.out)
})

test('RED perf-budget: a desktop surface with no committed budget fails', () => {
  const dir = fixture({ 'apps/desktop/package.json': '{}' })
  const r = runGate('check-perf-budget.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('perf-budget.json missing'), r.out)
})

test('RED rust gates: CI without the Rust surface fails closed', () => {
  const dir = fixture({})
  cpSync(join(TOOLS, 'run-rust-gates.mjs'), join(dir, 'tools/run-rust-gates.mjs'))
  for (const mode of ['fmt', 'check']) {
    const res = spawnSync('node', ['tools/run-rust-gates.mjs', mode], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
    })
    assert.equal(res.status, 1, `${mode}: ${res.stdout}${res.stderr}`)
  }
})

test('RED styleguide: styles without the design manifest fails loud', () => {
  const dir = fixture({ 'apps/desktop/src/styles.css': '@theme { --color-canvas: oklch(0.16 0.006 240); }' })
  const r = runGate('check-styleguide-manifest.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('styleguide.manifest.json missing'), r.out)
})
