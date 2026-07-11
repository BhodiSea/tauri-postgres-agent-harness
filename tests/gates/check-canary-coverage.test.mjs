// The canary-coverage checker must itself be falsifiable: green on the real
// registry, red when a step loses its proof or a hook grows an untested rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKER = fileURLToPath(new URL('../../scripts/check-canary-coverage.mjs', import.meta.url))
const REGISTRY = fileURLToPath(new URL('../canary/injections.json', import.meta.url))

function run(registryPath) {
  const res = spawnSync('node', [CHECKER, ...(registryPath ? [registryPath] : [])], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped registry covers every step and every proof resolves', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('provably red'), r.out)
})

test('RED: removing a step proof, adding a stale entry, or drifting a hook count all fail', () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'tpah-cancov-'))

  const missing = structuredClone(registry)
  delete missing.steps.styleguide
  writeFileSync(join(dir, 'missing.json'), JSON.stringify(missing))
  const m = run(join(dir, 'missing.json'))
  assert.equal(m.code, 1, m.out)
  assert.ok(m.out.includes("step 'styleguide' has NO red-proof"), m.out)

  const stale = structuredClone(registry)
  stale.steps['no-such-gate'] = [{ kind: 'fixture', ref: 'tests/gates/gate-canary-misc.test.mjs' }]
  writeFileSync(join(dir, 'stale.json'), JSON.stringify(stale))
  const s = run(join(dir, 'stale.json'))
  assert.equal(s.code, 1, s.out)
  assert.ok(s.out.includes('stale entry'), s.out)

  const drift = structuredClone(registry)
  drift.hookRules['pretool-bash-guard.mjs'].blockedMessages += 1
  writeFileSync(join(dir, 'drift.json'), JSON.stringify(drift))
  const d = run(join(dir, 'drift.json'))
  assert.equal(d.code, 1, d.out)
  assert.ok(d.out.includes('registry pins'), d.out)
})
