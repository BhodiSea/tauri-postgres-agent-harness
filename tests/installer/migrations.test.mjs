// Unit tests for the cross-version upgrade machinery (installer/lib/migrations.mjs)
// plus an end-to-end `update` run over a synthetic migration record. The real
// template/migrations.json is exercised by the update-skew CI lane against the
// previous release tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyFileMigrations,
  cmpVersions,
  injectConfigStep,
  requiredConfigSteps,
  updateConfigCommand,
  versionsBetween,
} from '../../installer/lib/migrations.mjs'
import { sha256 } from '../../installer/lib/manifest.mjs'
import { update } from '../../installer/commands/update.mjs'
import { init } from '../../installer/commands/init.mjs'

const CONFIG_TEMPLATE = fileURLToPath(
  new URL('../../template/base/tools/harness.config.mjs', import.meta.url),
)

test('cmpVersions orders numerically, not lexically', () => {
  assert.equal(cmpVersions('0.1.2', '0.1.10'), -1)
  assert.equal(cmpVersions('0.10.0', '0.9.9'), 1)
  assert.equal(cmpVersions('1.0.0', '1.0.0'), 0)
})

test('versionsBetween picks (from, to] ascending and ignores the doc key', () => {
  const m = { '//': 'doc', '0.1.2': {}, '0.1.3': {}, '0.2.0': {}, '0.1.10': {} }
  assert.deepEqual(versionsBetween(m, '0.1.1', '0.1.10'), ['0.1.2', '0.1.3', '0.1.10'])
  assert.deepEqual(versionsBetween(m, '0.1.3', '0.2.0'), ['0.1.10', '0.2.0'])
  assert.deepEqual(versionsBetween(m, '0.2.0', '0.2.0'), [])
})

test('updateConfigCommand: from-guarded rewrite hits canonical lines only, in BOTH step lists', () => {
  const cfg = `export const VALIDATE_STEPS = [
  ['lint', 'pnpm exec eslint . --max-warnings 0'],
  ['custom-lint', 'pnpm exec eslint . --max-warnings 0'],
]
export const STOP_HOOK_STEPS = [
  ['validate', 'node tools/validate.mjs'],
]`
  const afterLint = updateConfigCommand(cfg, {
    name: 'lint',
    from: 'pnpm exec eslint . --max-warnings 0',
    to: 'pnpm exec eslint . --max-warnings 0 --cache',
  })
  assert.ok(afterLint.includes("['lint', 'pnpm exec eslint . --max-warnings 0 --cache']"), afterLint)
  // a different step with the same command text is untouched (name-anchored)
  assert.ok(afterLint.includes("['custom-lint', 'pnpm exec eslint . --max-warnings 0']"), afterLint)

  const afterStop = updateConfigCommand(afterLint, {
    name: 'validate',
    from: 'node tools/validate.mjs',
    to: 'node tools/validate.mjs --report-all',
  })
  assert.ok(afterStop.includes("['validate', 'node tools/validate.mjs --report-all']"), afterStop)

  // customized consumer command: the from-guard misses, content unchanged
  const customized = "export const VALIDATE_STEPS = [\n  ['lint', 'my-own-linter --strict'],\n]"
  assert.equal(
    updateConfigCommand(customized, {
      name: 'lint',
      from: 'pnpm exec eslint . --max-warnings 0',
      to: 'pnpm exec eslint . --max-warnings 0 --cache',
    }),
    customized,
  )
  // idempotent: re-applying after the rewrite changes nothing
  assert.equal(
    updateConfigCommand(afterStop, {
      name: 'validate',
      from: 'node tools/validate.mjs',
      to: 'node tools/validate.mjs --report-all',
    }),
    afterStop,
  )
})

test('applyFileMigrations: sha-guarded removal, rename cleanup, module promotion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-mig-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools/stale.mjs'), 'old\n')
  writeFileSync(join(dir, 'tools/modified.mjs'), 'locally changed\n')
  writeFileSync(join(dir, 'tools/renamed-old.mjs'), 'moving\n')

  const files = {
    'tools/stale.mjs': { mode: 'owned', sha256: sha256('old\n') },
    'tools/modified.mjs': { mode: 'owned', sha256: sha256('pristine\n') }, // drifted
    'tools/renamed-old.mjs': { mode: 'owned', sha256: sha256('moving\n'), module: 'gate-perf-budget' },
    'tools/other.mjs': { mode: 'owned', sha256: 'x', module: 'gate-perf-budget' },
  }
  const modules = new Set(['gate-perf-budget', 'ci-macos'])
  const report = { notes: [] }

  applyFileMigrations({
    targetDir: dir,
    files,
    modules,
    report,
    entries: [
      {
        removed: ['tools/stale.mjs', 'tools/modified.mjs', 'tools/never-existed.mjs'],
        renamed: { 'tools/renamed-old.mjs': 'tools/renamed-new.mjs' },
        promotedModules: ['gate-perf-budget'],
      },
    ],
    dryRun: false,
  })

  assert.ok(!existsSync(join(dir, 'tools/stale.mjs')), 'unmodified removed file must be deleted')
  assert.ok(!files['tools/stale.mjs'], 'manifest entry pruned')
  assert.ok(existsSync(join(dir, 'tools/modified.mjs')), 'locally-modified file must survive')
  assert.ok(report.notes.some((n) => n.includes('locally modified')), report.notes.join('; '))
  assert.ok(!existsSync(join(dir, 'tools/renamed-old.mjs')), 'renamed old path deleted')
  assert.ok(!modules.has('gate-perf-budget'), 'promoted module removed from module list')
  assert.ok(modules.has('ci-macos'), 'unrelated module untouched')
  assert.equal(files['tools/other.mjs'].module, undefined, 'stale module attribution stripped')
})

test('injectConfigStep: uncomment, insert-after, append, idempotent, fail-null', () => {
  // A v0.1.1-shaped consumer config: styleguide still commented, no e2e.
  const OLD_SHAPE = `export const VALIDATE_STEPS = [
  ['format', 'pnpm exec biome ci .'],
  ['build', 'node tools/build-check.mjs'],
  ['rust-check', 'node tools/run-rust-gates.mjs check'],
  // Opt-in gates — uncomment after installing the matching module:
  // ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
]
`

  // Uncomment path.
  const uncommented = injectConfigStep(OLD_SHAPE, {
    name: 'styleguide',
    cmd: 'node tools/check-styleguide-manifest.mjs',
  })
  assert.ok(uncommented.includes("  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],"))
  assert.ok(!/\/\/\s*\['styleguide'/.test(uncommented), 'commented line must be activated')

  // Insert-after path.
  const withE2e = injectConfigStep(uncommented, {
    name: 'e2e',
    cmd: 'node tools/check-e2e.mjs',
    after: 'build',
  })
  const lines = withE2e.split('\n')
  const buildIdx = lines.findIndex((l) => l.includes("['build',"))
  assert.ok(lines[buildIdx + 1].includes("['e2e', 'node tools/check-e2e.mjs'],"), lines[buildIdx + 1])

  // Idempotent: injecting an already-present step is a no-op.
  assert.equal(injectConfigStep(withE2e, { name: 'e2e', cmd: 'node tools/check-e2e.mjs' }), withE2e)

  // Missing `after` anchor falls back to appending before the array close.
  const appended = injectConfigStep(OLD_SHAPE, { name: 'docs-sync', cmd: 'node tools/check-docs-sync.mjs', after: 'no-such-step' })
  assert.ok(appended.includes("['docs-sync', 'node tools/check-docs-sync.mjs'],"))

  // Mangled config → null (fail loud upstream, never guess).
  assert.equal(injectConfigStep('const nothing = 1\n', { name: 'x', cmd: 'y' }), null)
})

test('every shipped migration configStep is already ACTIVE in the shipped config (injection is a no-op)', () => {
  const shipped = readFileSync(CONFIG_TEMPLATE, 'utf8')
  const migrations = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../template/migrations.json', import.meta.url)), 'utf8'),
  )
  for (const [version, record] of Object.entries(migrations)) {
    if (version === '//') continue
    for (const step of record.configSteps ?? []) {
      assert.equal(
        injectConfigStep(shipped, step),
        shipped,
        `${version}: configStep '${step.name}' is not active in the shipped harness.config.mjs — a fresh init and an updated install would diverge`,
      )
    }
  }
})

test('requiredConfigSteps returns steps introduced at or before the version', () => {
  const m = {
    '//': 'doc',
    '0.1.3': { configSteps: [{ name: 'e2e', cmd: 'node tools/check-e2e.mjs' }] },
    '0.2.0': { configSteps: [{ name: 'later', cmd: 'x' }] },
  }
  const names = requiredConfigSteps(m, '0.1.3').map((s) => s.name)
  assert.deepEqual(names, ['e2e'])
  assert.equal(requiredConfigSteps(m, '0.1.3')[0].since, '0.1.3')
  assert.deepEqual(requiredConfigSteps(m, '0.2.0').map((s) => s.name), ['e2e', 'later'])
})

test('update applies a synthetic migration end-to-end (remove + configStep + promotion)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-updmig-'))
  const code = await init({
    dir,
    tier: 'core',
    yes: true,
    set: ['PROJECT_NAME=Mig App', 'GITHUB_OWNER=o', 'SECURITY_OWNERS=@o'],
  })
  assert.equal(code, 0)

  // Backdate the install and plant a stale harness-owned file the migration removes.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.harnessVersion = '0.0.1'
  writeFileSync(join(dir, 'tools/legacy-gate.mjs'), 'legacy\n')
  manifest.files['tools/legacy-gate.mjs'] = { mode: 'owned', sha256: sha256('legacy\n') }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const migrations = {
    '0.1.0': {
      removed: ['tools/legacy-gate.mjs'],
      configSteps: [{ name: 'synthetic-gate', cmd: 'node tools/synthetic.mjs', after: 'build' }],
    },
  }
  const updCode = await update({ dir, dryRun: false }, { migrations })
  assert.notEqual(updCode, 1)

  assert.ok(!existsSync(join(dir, 'tools/legacy-gate.mjs')), 'migration must delete the stale gate')
  const cfg = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.ok(cfg.includes("['synthetic-gate', 'node tools/synthetic.mjs'],"), 'configStep must be injected')

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(!after.files['tools/legacy-gate.mjs'], 'manifest entry pruned')
  assert.equal(
    after.files['tools/harness.config.mjs'].sha256,
    sha256(cfg),
    'config re-hashed after sanctioned injection so doctor sees no drift',
  )

  // Injection is idempotent across repeat updates.
  await update({ dir, dryRun: false }, { migrations })
  const cfg2 = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.equal(cfg2.split("['synthetic-gate',").length, 2, 'step must appear exactly once')
})
