// Skip-asymmetry proofs for the e2e gate (template/base/tools/check-e2e.mjs).
// Real browser runs live in the scaffold selftest lane — repo self-tests only
// prove the DETECTION contract: with the e2e surface present but no resolvable
// @playwright/test (a bare fixture has no node_modules), the gate must SKIP
// LOUDLY locally (exit 0, telling the agent what to install) and FAIL CLOSED in
// CI — a missing browser must never read as a green e2e lane.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-e2e.mjs', import.meta.url))

function fixture({ surface = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-e2egate-'))
  // Resolution boundary: a package.json without the dep, so createRequire can
  // never accidentally resolve a @playwright/test from a parent directory.
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n')
  if (surface) {
    writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}\n')
    mkdirSync(join(dir, 'e2e'), { recursive: true })
    writeFileSync(join(dir, 'e2e/smoke.spec.ts'), 'export {}\n')
  }
  return dir
}

function runGate(dir, { ci }) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.NODE_PATH
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('SKIP locally: e2e surface present but @playwright/test unresolvable → exit 0, loud skip', () => {
  const r = runGate(fixture(), { ci: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(r.out.includes('@playwright/test not resolvable'), r.out)
})

test('FAIL CLOSED in CI: the same fixture exits non-zero with CI=true', () => {
  const r = runGate(fixture(), { ci: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
})

test('no e2e surface at all: loud local skip naming the missing surface; CI fail-closed', () => {
  const local = runGate(fixture({ surface: false }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('no e2e surface'), local.out)
  const ci = runGate(fixture({ surface: false }), { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
