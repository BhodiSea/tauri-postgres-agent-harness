// Skip-asymmetry proofs for the e2e gate (template/base/tools/check-e2e.mjs).
// Real browser runs live in the scaffold selftest lane — repo self-tests only
// prove the DETECTION contract: with the e2e surface present but no resolvable
// @playwright/test (a bare fixture has no node_modules), the gate must SKIP
// LOUDLY locally (exit 0, telling the agent what to install) and FAIL CLOSED in
// CI — a missing browser must never read as a green e2e lane.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hashInputs } from '../../template/base/tools/lib/gate.mjs'
import { STAMP_INPUTS } from '../../template/base/tools/lib/stamp-inputs.mjs'

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

/** @param {string} dir @param {{ ci?: boolean, extraEnv?: Record<string, string> }} [opts] */
function runGate(dir, { ci = false, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.NODE_PATH
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// Write the exact digest a green run would record, so a warm run short-circuits
// WITHOUT any browser: hashInputs is cwd-relative, so compute it from inside the
// fixture (the gate does the same when it runs there).
function seedStamp(dir) {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/e2e.ok'), hashInputs(STAMP_INPUTS.e2e))
  } finally {
    process.chdir(prev)
  }
}

// A resolvable @playwright/test whose chromium.executablePath points at a real file,
// so the gate's registry probe passes without a real browser install.
function fakePlaywright(dir) {
  const pkg = join(dir, 'node_modules/@playwright/test')
  mkdirSync(pkg, { recursive: true })
  const exe = join(dir, 'node_modules/.chromium-stub')
  writeFileSync(exe, '#!/bin/sh\n')
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@playwright/test', version: '0.0.0', main: 'index.js' }),
  )
  writeFileSync(
    join(pkg, 'index.js'),
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(exe)} } }\n`,
  )
}

// A POSIX `pnpm` shim on PATH that stands in for `pnpm exec playwright test`,
// reporting the given passing-test count and exiting 0.
function fakePnpm(dir, passed) {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, 'pnpm')
  writeFileSync(shim, `#!/bin/sh\necho "Running tests"\necho "  ${passed} passed (1.0s)"\nexit 0\n`)
  chmodSync(shim, 0o755)
  return bin
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

// ── content-addressed stamp: the warm-path win (v0.1.4) ───────────────────────
test('warm re-run: a matching stamp reports inputs-unchanged before resolving/spawning playwright', () => {
  const dir = fixture() // surface present, but NO node_modules/@playwright at all
  seedStamp(dir)
  const r = runGate(dir, { ci: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('inputs unchanged'), r.out)
  // Proof it short-circuited BEFORE chromium detection: a bare fixture would
  // otherwise SKIP loudly with '@playwright/test not resolvable'.
  assert.ok(!r.out.includes('not resolvable'), r.out)
})

test('CI=true ignores a present stamp and fails closed on the missing browser', () => {
  const dir = fixture()
  seedStamp(dir)
  const r = runGate(dir, { ci: true })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FAIL'), r.out)
  assert.ok(!r.out.includes('inputs unchanged'), r.out)
})

test(
  'green run records the stamp (after anti-vacuity); the warm re-run then skips without spawning playwright',
  { skip: process.platform === 'win32' ? 'POSIX-only pnpm/browser shims' : false },
  () => {
    const dir = fixture()
    fakePlaywright(dir)
    const bin = fakePnpm(dir, 3)
    // Cold green run: the shims let chromium-detect pass and "playwright" report 3 passed.
    const cold = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(cold.code, 0, cold.out)
    assert.ok(cold.out.includes('3 e2e test(s) green'), cold.out)
    assert.ok(existsSync(join(dir, '.harness/e2e.ok')), 'a green run must record the stamp')
    // Warm re-run WITHOUT the pnpm shim on PATH: the stamp short-circuits before any
    // spawn, so the absent shim is never reached — proof playwright was not run.
    const warm = runGate(dir, { ci: false })
    assert.equal(warm.code, 0, warm.out)
    assert.ok(warm.out.includes('inputs unchanged'), warm.out)
  },
)

test(
  'a vacuous run (0 passing tests) FAILS and must NOT record a stamp',
  { skip: process.platform === 'win32' ? 'POSIX-only pnpm/browser shims' : false },
  () => {
    const dir = fixture()
    fakePlaywright(dir)
    const bin = fakePnpm(dir, 0)
    const r = runGate(dir, { ci: false, extraEnv: { PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('vacuous pass'), r.out)
    assert.ok(!existsSync(join(dir, '.harness/e2e.ok')), 'a vacuous run must never stamp')
  },
)
