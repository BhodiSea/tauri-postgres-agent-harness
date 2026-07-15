// The canary-coverage checker must itself be falsifiable: green on the real
// registry, red when a step loses its proof or a hook grows an untested rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKER = fileURLToPath(new URL('../../scripts/check-canary-coverage.mjs', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REGISTRY = fileURLToPath(new URL('../canary/injections.json', import.meta.url))
const HOOK_CONTRACT = fileURLToPath(new URL('../hooks/hook-contract.test.mjs', import.meta.url))

/**
 * Run the checker. Defaults to --no-spawn: these tests exercise the STATIC lockstep, and
 * spawning would recurse — the suite is already running the very proof files the checker would
 * spawn. One test below opts INTO spawning to prove the G28 execution path itself reds.
 * @param {string} [registryPath] @param {string} [hookContractPath] @param {{ spawn?: boolean }} [opts]
 */
function run(registryPath, hookContractPath, { spawn = false } = {}) {
  const args = []
  if (registryPath) args.push(registryPath)
  if (hookContractPath) args.push(hookContractPath)
  if (!spawn) args.push('--no-spawn')
  const res = spawnSync('node', [CHECKER, ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped registry covers every step and every proof resolves', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('CANARY COVERAGE: CLEAN'), r.out)
  assert.ok(r.out.includes('each carry a red-proof'), r.out)
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

test('RED (spawn, G28): a proof that RUNS but declares zero tests fails — empty is not a proof', () => {
  // The value spawning adds over existsSync: a fixture could exist, run green, and be EMPTY
  // (tests deleted or all commented out). A minimal registry keeps this to a single spawn — the
  // proof points at a real library module (scripts/lib/complexity.mjs) that has no `node --test`
  // tests. Other closure gaps in the minimal registry are noise; we assert the spawn verdict.
  //
  // This test is itself a REGRESSION GUARD against the first cut of this feature: it relied on a
  // `# tests N` count that node reports as 1 even for a zero-test file, so the check was dead
  // standalone and only "passed" via a NODE_TEST_CONTEXT recursion artifact when run under the
  // suite. The checker now strips NODE_TEST_* from its child env and detects emptiness by node's
  // synthetic `ok N - <path>.mjs` line, so this must red identically standalone and under `node
  // --test` — which is exactly what running it as part of this suite exercises.
  const dir = mkdtempSync(join(tmpdir(), 'tpah-cancov-empty-'))
  const bad = { steps: { styleguide: [{ kind: 'fixture', ref: 'scripts/lib/complexity.mjs' }] } }
  writeFileSync(join(dir, 'empty-proof.json'), JSON.stringify(bad))
  const r = run(join(dir, 'empty-proof.json'), undefined, { spawn: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declares ZERO tests'), r.out)
})

test('RED (spawn, G28): a proof BROKEN so it fails when run reds, naming the proof', () => {
  // The other spawn verdict: a proof the gate-under-test's refactor has broken now fails at
  // runtime. Point a step at a real fixture whose assertions we cannot satisfy by writing a
  // throwaway failing test file under the repo (so its ref resolves under ROOT), then assert the
  // checker surfaces "FAILS when run". Using an existing populated-but-passing proof would NOT
  // exercise this branch, which is why it needs its own broken fixture.
  const dir = mkdtempSync(join(tmpdir(), 'tpah-cancov-broken-'))
  const brokenRel = 'tests/gates/.tmp-broken-proof.test.mjs'
  writeFileSync(
    join(ROOT_DIR, brokenRel),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('deliberately fails', () => assert.equal(1, 2))\n",
  )
  try {
    const bad = { steps: { styleguide: [{ kind: 'fixture', ref: brokenRel }] } }
    writeFileSync(join(dir, 'broken-proof.json'), JSON.stringify(bad))
    const r = run(join(dir, 'broken-proof.json'), undefined, { spawn: true })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('FAILS when run'), r.out)
  } finally {
    rmSync(join(ROOT_DIR, brokenRel), { force: true })
  }
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
