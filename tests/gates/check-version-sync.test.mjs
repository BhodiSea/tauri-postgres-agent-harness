// Can-fail proofs for the version-sync gate (template/base/tools/check-version-sync.mjs).
// Regression armor for the v0.1.4 refactor: build a scaffold-shaped tree, run the
// real gate script with cwd inside it, assert the exact red/green for each rule —
//   1. one version across package.json / tauri.conf.json / apps/server / apps/desktop
//   2. .nvmrc / .node-version / engines.node agree on the Node MAJOR only
//   3. rc-churn catalog tools (babel-plugin-react-compiler, drizzle-kit,
//      @tauri-apps/cli) are EXACT-pinned — a caret/tilde reds.
// The zod single-instance sub-check is deliberately left untested: it only runs
// when `node_modules` exists in cwd and spawns `pnpm list -r … --json`, which
// needs a real installed workspace. Our fixtures never create node_modules, so
// that block is skipped entirely and no pnpm process is spawned.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-version-sync.mjs', import.meta.url),
)

// Every knob is optional; an undefined field means "do not write that file", which
// is exactly how a real scaffold looks before the corresponding surface exists.
/** @param {{ version?: any, serverVersion?: any, desktopVersion?: any, tauriVersion?: any, nvmrc?: any, nodeVersion?: any, enginesNode?: any, workspace?: any }} [knobs] */
function fixture({
  version = '0.1.4',
  serverVersion,
  desktopVersion,
  tauriVersion,
  nvmrc,
  nodeVersion,
  enginesNode,
  workspace,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-versionsync-'))
  const root = { name: 'root', private: true }
  if (version !== undefined) root.version = version
  if (enginesNode !== undefined) root.engines = { node: enginesNode }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(root, null, 2))
  if (serverVersion !== undefined) {
    mkdirSync(join(dir, 'apps/server'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/server/package.json'),
      JSON.stringify({ name: 'server', version: serverVersion }),
    )
  }
  if (desktopVersion !== undefined) {
    mkdirSync(join(dir, 'apps/desktop'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/desktop/package.json'),
      JSON.stringify({ name: 'desktop', version: desktopVersion }),
    )
  }
  if (tauriVersion !== undefined) {
    mkdirSync(join(dir, 'apps/desktop/src-tauri'), { recursive: true })
    writeFileSync(
      join(dir, 'apps/desktop/src-tauri/tauri.conf.json'),
      JSON.stringify({ version: tauriVersion }),
    )
  }
  if (nvmrc !== undefined) writeFileSync(join(dir, '.nvmrc'), nvmrc)
  if (nodeVersion !== undefined) writeFileSync(join(dir, '.node-version'), nodeVersion)
  if (workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const EXACT_CATALOG = [
  'catalog:',
  '  babel-plugin-react-compiler: 19.0.0-rc.1',
  '  drizzle-kit: 0.30.0',
  "  '@tauri-apps/cli': 2.1.0",
  '',
].join('\n')

test('GREEN: one version everywhere, node majors agree, rc tools exact-pinned', () => {
  const r = runGate(
    fixture({
      version: '0.1.4',
      serverVersion: '0.1.4',
      desktopVersion: '0.1.4',
      tauriVersion: '0.1.4',
      nvmrc: '22\n',
      nodeVersion: '22\n',
      enginesNode: '>=22',
      workspace: EXACT_CATALOG,
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('GREEN: a bare root package.json (no other surfaces) passes', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('version-sync: OK'), r.out)
})

test('RED: version drift between tauri.conf.json and the rest reds naming the drift', () => {
  const r = runGate(
    fixture({
      version: '0.1.4',
      serverVersion: '0.1.4',
      desktopVersion: '0.1.4',
      tauriVersion: '0.1.3',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(r.out.includes('tauri.conf.json=0.1.3'), r.out)
  assert.ok(r.out.includes('bump them together'), r.out)
})

test('RED: an apps/server version behind root reds', () => {
  const r = runGate(fixture({ version: '0.1.4', serverVersion: '0.1.3' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(r.out.includes('apps/server=0.1.3'), r.out)
})

test('RED: node major disagreement between .nvmrc and .node-version reds', () => {
  const r = runGate(fixture({ nvmrc: '22\n', nodeVersion: '20\n' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('node version disagreement'), r.out)
})

test('RED: node major disagreement between .nvmrc and engines.node reds', () => {
  const r = runGate(fixture({ nvmrc: '22\n', enginesNode: '>=20' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('node version disagreement'), r.out)
})

test('GREEN: node MAJORS agree despite differing minor/format (22.11.0 vs >=22 vs 22)', () => {
  const r = runGate(fixture({ nvmrc: '22.11.0\n', nodeVersion: '22\n', enginesNode: '>=22 <23' }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('RED: a caret on babel-plugin-react-compiler reds naming the tool + EXACT-pinned', () => {
  const workspace = ['catalog:', '  babel-plugin-react-compiler: ^19.0.0-rc.1', ''].join('\n')
  const r = runGate(fixture({ workspace }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('babel-plugin-react-compiler'), r.out)
  assert.ok(r.out.includes('EXACT-pinned'), r.out)
})

test('RED: a tilde on drizzle-kit reds', () => {
  const workspace = ['catalog:', '  drizzle-kit: ~0.30.0', ''].join('\n')
  const r = runGate(fixture({ workspace }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drizzle-kit'), r.out)
  assert.ok(r.out.includes('EXACT-pinned'), r.out)
})

test('RED: a caret on the quoted @tauri-apps/cli key reds (slash-escaped catalog match)', () => {
  const workspace = ['catalog:', "  '@tauri-apps/cli': ^2.1.0", ''].join('\n')
  const r = runGate(fixture({ workspace }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('@tauri-apps/cli'), r.out)
  assert.ok(r.out.includes('EXACT-pinned'), r.out)
})

test('GREEN: exact pins on all three rc-churn tools pass', () => {
  const r = runGate(fixture({ workspace: EXACT_CATALOG }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
})

test('skip asymmetry: no root package.json → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-versionsync-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

// ── content-addressed stamp (v0.1.4): kills the `pnpm list -r` subprocess warm ──
test('stamp: a green run records .harness/version-sync.ok; a warm re-run reports inputs-unchanged', () => {
  const dir = fixture({ version: '0.1.4', serverVersion: '0.1.4' })
  const cold = runGate(dir, { ci: false })
  assert.equal(cold.code, 0, cold.out)
  assert.ok(cold.out.includes('in lockstep'), cold.out)
  assert.ok(existsSync(join(dir, '.harness/version-sync.ok')), 'a green run must record the stamp')
  // The warm short-circuit happens at the top, before the zod/`pnpm list` block runs.
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes('inputs unchanged'), warm.out)
})

test('stamp: CI=true ignores a present stamp and re-runs the real check', () => {
  const dir = fixture({ version: '0.1.4' })
  runGate(dir, { ci: false }) // record a stamp
  const inCi = runGate(dir, { ci: true })
  assert.equal(inCi.code, 0, inCi.out)
  assert.ok(inCi.out.includes('in lockstep'), inCi.out)
  assert.ok(!inCi.out.includes('inputs unchanged'), inCi.out)
})

test('stamp: mutating a version input invalidates the stamp — the warm run re-checks and reds', () => {
  const dir = fixture({ version: '0.1.4', serverVersion: '0.1.4' })
  assert.equal(runGate(dir, { ci: false }).code, 0)
  // Drift apps/server behind root: the digest changes, so the stamp no longer skips.
  writeFileSync(
    join(dir, 'apps/server/package.json'),
    JSON.stringify({ name: 'server', version: '0.1.3' }),
  )
  const r = runGate(dir, { ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('version drift'), r.out)
  assert.ok(!r.out.includes('inputs unchanged'), r.out)
})
