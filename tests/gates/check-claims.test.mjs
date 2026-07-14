// The claims gate (G12) must be TRUE on the shipped docs and must be able to RED.
// v0.1.5 shipped a README claiming cold ≈70 s while the CHANGELOG claimed ≈85 s for the
// same release, and "22 gates" was never recomputed — a harness whose headline is
// "prove, don't claim" cannot ship unverified numbers about itself.
import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-claims.mjs', import.meta.url))
const README = fileURLToPath(new URL('../../README.md', import.meta.url))

const run = () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('GREEN: the shipped README claims match the computed truth', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLAIMS: CLEAN/)
})

test('RED: a drifted chain-length claim in the README fails, naming the true count', () => {
  const backup = `${README}.claims-test.bak`
  copyFileSync(README, backup)
  try {
    const original = readFileSync(README, 'utf8')
    // "all 22 gates" → "all 23 gates": the chain is the source of truth, so this must red.
    writeFileSync(README, original.replace('all 22 gates', 'all 23 gates'))
    const r = run()
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /23 gates\/steps.*VALIDATE_STEPS has 22/s)
  } finally {
    copyFileSync(backup, README)
    spawnSync('rm', ['-f', backup])
  }
})
