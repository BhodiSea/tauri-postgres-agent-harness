// Can-fail + can-pass proofs for the diff-coverage gate
// (template/base/tools/check-diff-coverage.mjs). Two layers, mirroring the
// check-seeded-migrations pattern: the PURE classifier
// (evaluateDiffCoverage: changed files × coverage map × floors → findings) is
// unit-tested in-process with fixture data — including coverage-map path
// normalization for POSIX and Windows absolute keys — while the CLI wrapper
// (git plumbing, fail-closed parses, artifact checks) is spawned against a
// real throwaway git repo, so the registered red-proof exercises the actual
// exit-1 path the Stop hook sees.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  evaluateDiffCoverage,
  parseCoverageExcludes,
  parsePerFileFloors,
} from '../../template/base/tools/check-diff-coverage.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const GATE = join(TOOLS, 'check-diff-coverage.mjs')
const SHIPPED_VITEST_CONFIG = fileURLToPath(
  new URL('../../template/base/vitest.config.ts', import.meta.url),
)

const FLOORS = { statements: 50, branches: 40, functions: 45, lines: 50 }

// A minimal istanbul-format file entry: `covered` of `total` statements (one
// per line), one function and one branch pair, all hit iff any statement is.
function fileCov(path, { covered, total }) {
  const statementMap = {}
  const s = {}
  for (let i = 0; i < total; i += 1) {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } }
    s[i] = i < covered ? 1 : 0
  }
  const hit = covered > 0 ? 1 : 0
  return {
    path,
    statementMap,
    s,
    fnMap: { 0: { name: 'f', line: 1 } },
    f: { 0: hit },
    branchMap: { 0: { line: 1 } },
    b: { 0: [hit, hit] },
  }
}

// ---- pure classifier ------------------------------------------------------------

test('an uncovered new src file (absent from the coverage map) is a finding', () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    coverageJson: {},
    floors: FLOORS,
  })
  assert.deepEqual(checked, ['apps/server/src/dal/widgets.ts'])
  assert.deepEqual(findings, [{ file: 'apps/server/src/dal/widgets.ts', kind: 'uncovered' }])
})

test('a changed file below a per-file floor is a finding naming metric, actual, floor', () => {
  const { findings } = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    coverageJson: {
      'apps/server/src/dal/widgets.ts': fileCov('apps/server/src/dal/widgets.ts', {
        covered: 1,
        total: 4, // 25% statements + lines — below 50/50; functions+branches hit
      }),
    },
    floors: FLOORS,
  })
  assert.deepEqual(findings, [
    { file: 'apps/server/src/dal/widgets.ts', kind: 'below-floor', metric: 'statements', actual: 25, floor: 50 },
    { file: 'apps/server/src/dal/widgets.ts', kind: 'below-floor', metric: 'lines', actual: 25, floor: 50 },
  ])
})

test('a changed file exactly AT every floor is green (vitest compares pct < threshold)', () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: ['packages/importer/src/parse.ts'],
    coverageJson: {
      'packages/importer/src/parse.ts': fileCov('packages/importer/src/parse.ts', {
        covered: 2,
        total: 4, // exactly 50% statements + lines; functions/branches 100
      }),
    },
    floors: FLOORS,
  })
  assert.equal(checked.length, 1)
  assert.deepEqual(findings, [])
})

test('a fully uncovered-but-present file reds every metric (the 0% wash the aggregate hides)', () => {
  const { findings } = evaluateDiffCoverage({
    changedFiles: ['apps/desktop/src/features/widgets/useWidgets.ts'],
    coverageJson: {
      'apps/desktop/src/features/widgets/useWidgets.ts': fileCov(
        'apps/desktop/src/features/widgets/useWidgets.ts',
        { covered: 0, total: 5 },
      ),
    },
    floors: FLOORS,
  })
  assert.deepEqual(
    findings.map((f) => f.metric),
    ['statements', 'branches', 'functions', 'lines'],
  )
})

test('empty diff → zero checked files, zero findings', () => {
  const r = evaluateDiffCoverage({ changedFiles: [], coverageJson: {}, floors: FLOORS })
  assert.deepEqual(r, { findings: [], checked: [] })
})

test('non-source changed files are ignored: outside src trees, tests, .d.ts, non-code, excludes', () => {
  const { findings, checked } = evaluateDiffCoverage({
    changedFiles: [
      'README.md',
      'tools/check-migrations.mjs',
      'e2e/states.spec.ts',
      'apps/desktop/src/App.test.tsx', // colocated test
      'apps/server/tests/unit/app.test.ts', // not under src/
      'apps/desktop/src/vite-env.d.ts', // .d.ts
      'apps/desktop/src/styles.css', // not a code file
      'apps/desktop/src/ipc/bindings.ts', // COVERAGE_EXCLUDE exact path
      'apps/server/src/db/client.ts', // COVERAGE_EXCLUDE exact path
    ],
    coverageJson: {},
    floors: FLOORS,
    excludes: parseCoverageExcludes(readShippedConfig()),
  })
  assert.deepEqual(checked, [])
  assert.deepEqual(findings, [])
})

test('coverage-map keys are normalized: absolute POSIX and Windows-separator paths both match', () => {
  const posix = evaluateDiffCoverage({
    changedFiles: ['apps/server/src/dal/widgets.ts'],
    coverageJson: {
      '/home/dev/proj/apps/server/src/dal/widgets.ts': fileCov('x', { covered: 4, total: 4 }),
    },
    floors: FLOORS,
    root: '/home/dev/proj',
  })
  assert.deepEqual(posix.findings, [])
  assert.equal(posix.checked.length, 1)

  const win = evaluateDiffCoverage({
    changedFiles: ['apps\\server\\src\\dal\\widgets.ts'],
    coverageJson: {
      'D:\\a\\proj\\apps\\server\\src\\dal\\widgets.ts': fileCov('x', { covered: 4, total: 4 }),
    },
    floors: FLOORS,
    root: 'd:\\a\\proj', // drive-letter case may differ between the map and cwd
  })
  assert.deepEqual(win.findings, [])
  assert.equal(win.checked.length, 1)
})

// ---- fail-closed parses against the SHIPPED config -------------------------------

function readShippedConfig() {
  return readFileSync(SHIPPED_VITEST_CONFIG, 'utf8')
}

test('the SHIPPED vitest.config.ts parses: floors 50/40/45/50 and the exclusion list', () => {
  const floors = parsePerFileFloors(readShippedConfig())
  assert.deepEqual(floors, FLOORS)
  const excludes = parseCoverageExcludes(readShippedConfig())
  assert.ok(excludes.includes('**/*.d.ts'))
  assert.ok(excludes.includes('apps/desktop/src/ipc/bindings.ts'))
  assert.ok(excludes.includes('apps/server/src/db/context.ts'))
})

test('a config without the floor block (or with a metric missing) parses to null — the CLI fails closed on it', () => {
  assert.equal(parsePerFileFloors('export default {}'), null)
  assert.equal(
    parsePerFileFloors('const PER_FILE_FLOORS = { statements: 50, branches: 40, functions: 45 }'),
    null, // lines missing
  )
  assert.equal(parseCoverageExcludes('export default {}'), null)
})

// ---- CLI wrapper against a real throwaway git repo --------------------------------

/** @param {{ vitestConfig?: string, coverage?: any }} [opts] */
function gitFixture({ vitestConfig, coverage } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-diffcov-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(GATE, join(dir, 'tools/check-diff-coverage.mjs'))
  writeFileSync(
    join(dir, 'vitest.config.ts'),
    vitestConfig ?? readShippedConfig(), // the GREEN case proves the shipped config parses
  )
  if (coverage !== undefined) {
    mkdirSync(join(dir, 'coverage'), { recursive: true })
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify(coverage))
  }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '-qm', 'baseline')
  return dir
}

function runGate(dir, { ci = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync('node', ['tools/check-diff-coverage.mjs'], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: clean tree → "no changed source files" one-liner, exit 0', () => {
  const dir = gitFixture({ coverage: {} })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('no changed source files'), r.out)
})

test('RED: an untracked, never-imported src file fails naming it + the vitest reproduce command', () => {
  const dir = gitFixture({ coverage: {} })
  mkdirSync(join(dir, 'apps/server/src/dal'), { recursive: true })
  writeFileSync(join(dir, 'apps/server/src/dal/widgets.ts'), 'export const widgets = () => 1\n')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/dal/widgets.ts'), r.out)
  assert.ok(r.out.includes('absent from coverage/coverage-final.json'), r.out)
  assert.ok(r.out.includes('pnpm exec vitest run --coverage --silent'), r.out)
  assert.ok(r.out.includes('FIX[diff-coverage]'), r.out)
})

test('GREEN: the same untracked file passes once the coverage map carries it above the floors', () => {
  const covered = fileCov('apps/server/src/dal/widgets.ts', { covered: 4, total: 4 })
  const dir = gitFixture({ coverage: { 'apps/server/src/dal/widgets.ts': covered } })
  mkdirSync(join(dir, 'apps/server/src/dal'), { recursive: true })
  writeFileSync(join(dir, 'apps/server/src/dal/widgets.ts'), 'export const widgets = () => 1\n')
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('1 changed source file(s) clear the per-file floors'), r.out)
})

test('FAIL CLOSED: missing coverage-final.json reds even on a clean tree, naming the unit step', () => {
  const dir = gitFixture({ coverage: undefined })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('coverage/coverage-final.json not found'), r.out)
  assert.ok(r.out.includes('run the unit step first'), r.out)
})

test('FAIL CLOSED: a vitest.config.ts without PER_FILE_FLOORS reds rather than inventing numbers', () => {
  const dir = gitFixture({ vitestConfig: 'export default {}\n', coverage: {} })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no parseable PER_FILE_FLOORS'), r.out)
})

test('outside a git repo: loud SKIP locally, FAIL in CI (never a silent pass)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-diffcov-nogit-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(GATE, join(dir, 'tools/check-diff-coverage.mjs'))
  writeFileSync(join(dir, 'vitest.config.ts'), readShippedConfig())
  mkdirSync(join(dir, 'coverage'), { recursive: true })
  writeFileSync(join(dir, 'coverage/coverage-final.json'), '{}')
  const local = runGate(dir)
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
