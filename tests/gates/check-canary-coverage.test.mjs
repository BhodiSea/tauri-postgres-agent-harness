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
const HOOK_CONTRACT = fileURLToPath(new URL('../hooks/hook-contract.test.mjs', import.meta.url))

function run(registryPath, hookContractPath) {
  const args = []
  if (registryPath) args.push(registryPath)
  if (hookContractPath) args.push(hookContractPath)
  const res = spawnSync('node', [CHECKER, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped registry covers every step and every proof resolves', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('provably red'), r.out)
})

test('RED: a missing step proof or a stale registry entry fails', () => {
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
})

test('RED: a guard rule id with no behavioral canary fails, naming the rule', () => {
  // Point the checker at a hook-contract copy whose RULE_CANARIES entry for a real
  // rule id has been stripped — the per-rule closure must red and name that id.
  const dir = mkdtempSync(join(tmpdir(), 'tpah-cancov-closure-'))
  const contract = readFileSync(HOOK_CONTRACT, 'utf8').replaceAll("'rm-rf'", "'rm-XX'")
  const fixture = join(dir, 'hook-contract.test.mjs')
  writeFileSync(fixture, contract)
  const r = run(REGISTRY, fixture)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("guard rule id 'rm-rf'"), r.out)
})

test('RED: a registry denyExample absent from the hook-contract fails', () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'tpah-cancov-dex-'))
  const bogus = structuredClone(registry)
  bogus.hookRules['pretool-bash-guard.mjs'].denyExamples.push('this command has no deny test')
  writeFileSync(join(dir, 'bogus.json'), JSON.stringify(bogus))
  const r = run(join(dir, 'bogus.json'))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not found in tests/hooks/hook-contract.test.mjs'), r.out)
})
