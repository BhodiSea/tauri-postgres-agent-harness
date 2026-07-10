// End-to-end installer lifecycle against the real template tree:
// init (bootstrap + retrofit + dry-run), update drift semantics, doctor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../../installer/cli.mjs', import.meta.url).pathname

function run(args, { cwd, expectFail = false } = {}) {
  try {
    return execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (expectFail) return `${err.stdout ?? ''}${err.stderr ?? ''}`
    throw new Error(`cli failed: ${err.stderr ?? err.message}`)
  }
}

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

test('bootstrap init renders a complete project with manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-boot-'))
  run(['init', '--dir', dir, '--yes', ...SETS])

  for (const expected of [
    'package.json',
    '.claude/settings.json',
    '.claude/hooks/stop-validate-gate.mjs',
    'tools/harness.config.mjs',
    'tools/validate.mjs',
    '.github/workflows/quality-gate.yml',
    '.gitignore',
    'CLAUDE.md',
    'app/page.tsx',
    'supabase/migrations/20260707000000_notes.sql',
    '.harness/manifest.json',
  ]) {
    assert.ok(existsSync(join(dir, expected)), `missing ${expected}`)
  }

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'fixture-app')
  assert.equal(pkg.scripts.validate, 'node tools/validate.mjs')

  const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
  assert.ok(claude.includes('Fixture App'), 'CLAUDE.md placeholder rendered')
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(claude), 'no unrendered tokens in CLAUDE.md')

  const owners = readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')
  assert.ok(owners.includes('@fixture-owner'), 'CODEOWNERS rendered')

  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(manifest.mode, 'bootstrap')
  assert.equal(manifest.files['app/page.tsx'].mode, 'seeded')
  assert.equal(manifest.files['.claude/hooks/stop-validate-gate.mjs'].mode, 'owned')
  assert.equal(manifest.files['tools/harness.config.mjs'].mode, 'config')
})

test('dry-run writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-dry-'))
  run(['init', '--dir', dir, '--yes', '--dry-run', ...SETS])
  assert.ok(!existsSync(join(dir, 'package.json')))
  assert.ok(!existsSync(join(dir, '.harness')))
})

test('retrofit merges package.json, never clobbers configs, skips app code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-retro-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'existing', dependencies: { next: '16.0.0' }, scripts: { validate: 'my-gate' } }),
  )
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default []\n')
  mkdirSync(join(dir, 'app'))
  writeFileSync(join(dir, 'app/page.tsx'), 'export default function P() { return null }\n')

  // Conflicts are reported with exit code 2 by design — tolerate it here.
  run(['init', '--dir', dir, '--yes', ...SETS], { expectFail: true })

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.validate, 'my-gate', 'existing validate kept')
  assert.equal(pkg.scripts['harness:validate'], 'node tools/validate.mjs')
  assert.equal(readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'), 'export default []\n', 'existing eslint kept')
  assert.ok(existsSync(join(dir, 'eslint.config.harness.mjs')), 'harness eslint sibling written')
  assert.equal(
    readFileSync(join(dir, 'app/page.tsx'), 'utf8'),
    'export default function P() { return null }\n',
    'app code untouched',
  )
  assert.ok(!existsSync(join(dir, 'supabase/migrations/20260707000000_notes.sql')), 'stack migration not installed on retrofit')
  assert.ok(existsSync(join(dir, 'proxy.ts')), 'additive stack seed installed when absent')
  // The Stop gate invokes the runner directly (tamper-evidence), so a colliding package.json
  // "validate" script cannot hollow it out — no rebinding needed.
  const cfg = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.ok(cfg.includes('node tools/validate.mjs'), 'stop gate invokes the runner directly')
})

test('retrofit rejects src/ layouts with a clear message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-src-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }))
  mkdirSync(join(dir, 'src'))
  const out = run(['init', '--dir', dir, '--yes', ...SETS], { expectFail: true })
  assert.ok(out.includes('src/ layout'), out)
})

test('update upgrades unmodified owned files and preserves drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-upd-'))
  run(['init', '--dir', dir, '--yes', ...SETS])

  const owned = join(dir, '.claude/hooks/posttool-fast-check.mjs')
  const original = readFileSync(owned, 'utf8')
  writeFileSync(owned, `${original}\n// local tweak\n`)

  run(['update', '--dir', dir], { expectFail: true }) // drift → exit 2

  assert.ok(readFileSync(owned, 'utf8').includes('// local tweak'), 'drifted file preserved')
  assert.ok(
    existsSync(join(dir, '.harness/pending/.claude/hooks/posttool-fast-check.mjs')),
    'incoming version parked under .harness/pending/',
  )

  // Seeded files are never overwritten by update.
  const seeded = join(dir, 'CLAUDE.md')
  writeFileSync(seeded, '# mine now\n')
  run(['update', '--dir', dir], { expectFail: true })
  assert.equal(readFileSync(seeded, 'utf8'), '# mine now\n')
})

test('doctor reports CLEAN right after init and flags drift after edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-doc-'))
  run(['init', '--dir', dir, '--yes', ...SETS])
  const clean = run(['doctor', '--dir', dir])
  assert.ok(clean.includes('CLEAN'), clean)

  writeFileSync(join(dir, 'tools/validate.mjs'), '// hollowed out\n')
  const out = run(['doctor', '--dir', dir], { expectFail: true })
  assert.ok(/drift|ERROR/i.test(out), out)
})

test('npm pack ships every template path (dotless storage survives packing)', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const critical of [
    'template/base/.claude/settings.json',
    'template/base/.claude/hooks/stop-validate-gate.mjs',
    'template/base/gitignore',
    'template/base/github/workflows/quality-gate.yml',
    'template/base/tools/harness.config.mjs',
    'installer/cli.mjs',
  ]) {
    assert.ok(files.includes(critical), `npm pack dropped ${critical}`)
  }
})
