// End-to-end installer lifecycle against the real template tree:
// init (bootstrap + retrofit + dry-run), update refresh/drift semantics,
// doctor exit codes, module enable/disable, CI-floor lockstep, npm pack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// Run the CLI, always returning { code, out } — exit codes are part of the
// contract here (0 clean, 1 broken, 2 conflicts/drift), so never throw.
function run(args, { cwd } = {}) {
  const res = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

// Walk a scaffold looking for unrendered {{PLACEHOLDER}} tokens. Binary assets
// and the manifest (which records raw template metadata) are excluded.
function placeholderResidue(dir) {
  const hits = []
  ;(function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) {
        if (entry === '.harness' || entry === 'node_modules' || entry === '.git') continue
        walk(p)
        continue
      }
      if (/\.(png|ico|icns)$/.test(entry)) continue
      const text = readFileSync(p, 'utf8')
      if (/\{\{[A-Z0-9_]+\}\}/.test(text)) hits.push(p.slice(dir.length + 1))
    }
  })(dir)
  return hits
}

test('bootstrap init renders the monorepo layout with manifest modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-boot-'))
  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 0, r.out)

  for (const expected of [
    'package.json',
    'pnpm-workspace.yaml',
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/settings.json',
    '.claude/hooks/stop-validate-gate.mjs',
    'tools/harness.config.mjs',
    'tools/validate.mjs',
    'tools/identity.lock.json',
    'docker-compose.yml',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/server/src/app.ts',
    'packages/schema/drizzle/0000_init.sql',
    'tests/rls/run-rls.mjs',
    '.harness/manifest.json',
  ]) {
    assert.ok(existsSync(join(dir, expected)), `missing ${expected}`)
  }

  // Dotless storage names must land at their dot-path installs — and the
  // dotless twins must NOT exist in the scaffold.
  for (const [stored, installed] of [
    ['gitignore', '.gitignore'],
    ['gitattributes', '.gitattributes'],
    ['editorconfig', '.editorconfig'],
    ['nvmrc', '.nvmrc'],
    ['node-version', '.node-version'],
    ['dependency-cruiser.cjs', '.dependency-cruiser.cjs'],
    ['mcp.json', '.mcp.json'],
    ['env.example', '.env.example'],
  ]) {
    assert.ok(existsSync(join(dir, installed)), `rename not applied: ${stored} → ${installed}`)
    assert.ok(!existsSync(join(dir, stored)), `dotless twin leaked into scaffold: ${stored}`)
  }
  // github/ → .github applies once the template ships a github tree (CI
  // workflow modules land there); assert whenever the source exists.
  if (existsSync(join(TEMPLATE, 'base/github'))) {
    assert.ok(existsSync(join(dir, '.github')), 'github/ not renamed to .github')
    assert.ok(!existsSync(join(dir, 'github')), 'dotless github/ leaked into scaffold')
  }

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'fixture-app')
  assert.equal(pkg.scripts.validate, 'node tools/validate.mjs')

  // CLAUDE.md must be a pure @AGENTS.md include (doctor enforces this later).
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md')

  // Tauri identity: rendered, and in lockstep with the identity lock.
  const conf = JSON.parse(readFileSync(join(dir, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(dir, 'tools/identity.lock.json'), 'utf8'))
  assert.equal(conf.productName, 'Fixture App')
  assert.equal(conf.identifier, lock.identifier, 'tauri identifier must match identity.lock.json')
  assert.ok(conf.identifier.length <= 30, 'identifier exceeds the 30-char MSI derivation limit')

  // Zero placeholder residue anywhere in the rendered scaffold.
  assert.deepEqual(placeholderResidue(dir), [], 'unrendered {{TOKENS}} in scaffold')

  // Manifest modes: config vs seeded vs owned drive update/doctor semantics.
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(manifest.mode, 'bootstrap')
  assert.equal(manifest.files['tools/harness.config.mjs'].mode, 'config')
  assert.equal(manifest.files['tools/validate.mjs'].mode, 'owned')
  assert.equal(manifest.files['.claude/hooks/stop-validate-gate.mjs'].mode, 'owned')
  assert.equal(manifest.files['apps/desktop/src-tauri/tauri.conf.json'].mode, 'seeded')
  assert.equal(manifest.files['apps/server/src/app.ts'].mode, 'seeded')
  assert.equal(manifest.files['packages/schema/drizzle/0000_init.sql'].mode, 'seeded')
  assert.equal(manifest.files['pnpm-workspace.yaml'].mode, 'seeded')
  assert.equal(manifest.files['AGENTS.md'].mode, 'seeded')
})

test('dry-run writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-dry-'))
  const r = run(['init', '--dir', dir, '--yes', '--dry-run', ...SETS])
  assert.equal(r.code, 0, r.out)
  assert.ok(!existsSync(join(dir, 'package.json')))
  assert.ok(!existsSync(join(dir, '.harness')))
})

test('retrofit: non-clobber configs, merged workspace yaml, no stack app code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-retro-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'existing', dependencies: { hono: '^4.0.0' }, scripts: { validate: 'my-own-gate' } }),
  )
  const theirWorkspace = "# their workspace\npackages:\n  - 'apps/*'\n"
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), theirWorkspace)
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default []\n')
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  writeFileSync(join(dir, 'apps/server/package.json'), '{"name":"server"}\n')
  writeFileSync(join(dir, 'apps/server/src/index.ts'), 'export const theirs = true\n')

  // Conflicts (validate script, eslint config) are reported with exit 2 by design.
  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 2, r.out)

  // package.json: merged, never clobbered.
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.validate, 'my-own-gate', 'existing validate script must be kept')
  assert.equal(pkg.scripts['harness:validate'], 'node tools/validate.mjs')

  // Root configs: theirs byte-identical, ours at a .harness sibling.
  assert.equal(readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'), 'export default []\n')
  assert.ok(existsSync(join(dir, 'eslint.config.harness.mjs')), 'harness eslint sibling missing')

  // pnpm-workspace.yaml is MERGED (glob union + catalog add-missing), not suffixed.
  const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  assert.ok(ws.startsWith('# their workspace'), 'their workspace header must survive the merge')
  assert.match(ws, /- 'apps\/\*'/, 'their glob must survive')
  assert.match(ws, /- 'packages\/\*'/, 'harness glob must be unioned in')
  assert.match(ws, /catalog:/, 'harness catalog must be added')
  assert.match(ws, /drizzle-orm/, 'harness catalog pins must be present')
  assert.ok(!existsSync(join(dir, 'pnpm-workspace.harness.yaml')), 'workspace yaml must merge, not suffix')

  // Their app code untouched; our stack app code NOT installed on retrofit.
  assert.equal(readFileSync(join(dir, 'apps/server/src/index.ts'), 'utf8'), 'export const theirs = true\n')
  assert.equal(readFileSync(join(dir, 'apps/server/package.json'), 'utf8'), '{"name":"server"}\n')
  assert.ok(!existsSync(join(dir, 'apps/desktop')), 'stack desktop app installed on retrofit')
  assert.ok(!existsSync(join(dir, 'packages/schema/drizzle/0000_init.sql')), 'stack migration installed on retrofit')
  // Additive workspace-package seeds ARE installed when absent.
  assert.ok(existsSync(join(dir, 'packages/schema/package.json')), 'additive schema package seed missing')

  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(manifest.mode, 'retrofit')

  // The Stop gate invokes the runner directly, so the colliding "validate"
  // script cannot hollow it out.
  const cfg = readFileSync(join(dir, 'tools/harness.config.mjs'), 'utf8')
  assert.ok(cfg.includes('node tools/validate.mjs'), 'stop gate must invoke the runner directly')
})

test('retrofit rejects Next.js projects and non-workspace layouts with clear messages', () => {
  const nextDir = mkdtempSync(join(tmpdir(), 'tpah-next-'))
  writeFileSync(join(nextDir, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }))
  const nextRes = run(['init', '--dir', nextDir, '--yes', ...SETS])
  assert.equal(nextRes.code, 1, nextRes.out)
  assert.ok(nextRes.out.includes('Tauri 2 + Hono'), nextRes.out)

  const bareDir = mkdtempSync(join(tmpdir(), 'tpah-bare-'))
  writeFileSync(join(bareDir, 'package.json'), JSON.stringify({ dependencies: { hono: '^4.0.0' } }))
  const bareRes = run(['init', '--dir', bareDir, '--yes', ...SETS])
  assert.equal(bareRes.code, 1, bareRes.out)
  assert.ok(bareRes.out.includes('pnpm-workspace.yaml'), bareRes.out)
})

test('update refreshes unmodified owned files, preserves drift, never touches seeded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-upd-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // 1. REFRESH: simulate a file installed by an older harness version —
  // content differs from the incoming template but MATCHES its manifest hash
  // (i.e. not locally modified). Update must overwrite it in place.
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const oldContent = '#!/usr/bin/env node\n// old harness version\n'
  writeFileSync(owned, oldContent)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files[ownedRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const refresh = run(['update', '--dir', dir])
  assert.equal(refresh.code, 0, refresh.out)
  const refreshed = readFileSync(owned, 'utf8')
  assert.notEqual(refreshed, oldContent, 'unmodified owned file must be refreshed')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[ownedRel].sha256, sha256(refreshed), 'manifest hash must track the refresh')

  // 2. DRIFT: a locally-modified owned file is preserved; the incoming version
  // parks under .harness/pending/ and update exits 2.
  writeFileSync(owned, `${refreshed}\n// local tweak\n`)
  const drift = run(['update', '--dir', dir])
  assert.equal(drift.code, 2, drift.out)
  assert.ok(readFileSync(owned, 'utf8').includes('// local tweak'), 'drifted file must be preserved')
  assert.ok(
    existsSync(join(dir, '.harness/pending', ownedRel)),
    'incoming version must be parked under .harness/pending/',
  )

  // 3. SEEDED: never overwritten by update, no matter what.
  const seeded = join(dir, 'AGENTS.md')
  writeFileSync(seeded, '# mine now\n')
  run(['update', '--dir', dir]) // exit 2 from the still-drifted hook — irrelevant here
  assert.equal(readFileSync(seeded, 'utf8'), '# mine now\n', 'seeded file must never be touched')
})

test('doctor exit codes: clean=0, drift=2, broken=1; CLAUDE.md purity enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-doc-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // clean → 0
  const clean = run(['doctor', '--dir', dir])
  assert.equal(clean.code, 0, clean.out)
  assert.ok(clean.out.includes('CLEAN'), clean.out)

  // locally modified owned hook → drift warning → 2
  const hook = join(dir, '.claude/hooks/pretool-bash-guard.mjs')
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n// tweak\n`)
  const drift = run(['doctor', '--dir', dir])
  assert.equal(drift.code, 2, drift.out)
  assert.match(drift.out, /locally modified hook/i, drift.out)
  run(['update', '--dir', dir, '--force']) // restore the hook so later checks stay isolated
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'restore before next mutation failed')

  // CLAUDE.md must stay a pure @AGENTS.md include → impurity is drift (2)
  const claudeMd = join(dir, 'CLAUDE.md')
  writeFileSync(claudeMd, '@AGENTS.md\n\n# extra memory that belongs in AGENTS.md\n')
  const impure = run(['doctor', '--dir', dir])
  assert.equal(impure.code, 2, impure.out)
  assert.match(impure.out, /pure `@AGENTS\.md` include/, impure.out)
  writeFileSync(claudeMd, '@AGENTS.md\n')
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'restore before next mutation failed')

  // missing owned gate runner → broken → 1
  rmSync(join(dir, 'tools/validate.mjs'))
  const broken = run(['doctor', '--dir', dir])
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /ERROR/, broken.out)
})

test('enable/disable flips a module and its manifest entries', (t) => {
  const modulesRoot = join(TEMPLATE, 'modules')
  let moduleName = 'gate-styleguide'
  if (!existsSync(join(modulesRoot, moduleName))) {
    const available = existsSync(modulesRoot)
      ? readdirSync(modulesRoot).filter((e) => statSync(join(modulesRoot, e)).isDirectory())
      : []
    if (available.length === 0) {
      // TODO: drop this skip once template/modules/gate-styleguide lands —
      // then this test always runs against a real module tree.
      t.skip('no template/modules/* trees exist yet')
      return
    }
    moduleName = available[0]
  }

  const dir = mkdtempSync(join(tmpdir(), 'tpah-mod-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)

  const on = run(['enable', moduleName, '--dir', dir])
  assert.equal(on.code, 0, on.out)
  const enabled = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(enabled.modules.includes(moduleName), 'module not recorded in manifest')
  const moduleFiles = Object.entries(enabled.files).filter(([, meta]) => meta.module === moduleName)
  assert.ok(moduleFiles.length > 0, `module ${moduleName} installed no files`)
  for (const [ip] of moduleFiles) {
    assert.ok(existsSync(join(dir, ip)), `enabled module file missing: ${ip}`)
  }

  const off = run(['disable', moduleName, '--dir', dir])
  assert.equal(off.code, 0, off.out)
  const disabled = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(!disabled.modules.includes(moduleName), 'module still recorded after disable')
  for (const [ip] of moduleFiles) {
    assert.ok(!existsSync(join(dir, ip)), `disabled module file still present: ${ip}`)
    assert.ok(!(ip in disabled.files), `disabled module file still in manifest: ${ip}`)
  }
})

test('CI floor is in lockstep with VALIDATE_STEPS (a weakened config cannot weaken CI)', async () => {
  const validateSrc = readFileSync(join(TEMPLATE, 'base/tools/validate.mjs'), 'utf8')
  const floorBlock = validateSrc.match(/const FLOOR = \[([\s\S]*?)\n\]/)
  assert.ok(floorBlock, 'FLOOR array not found in tools/validate.mjs')
  const floor = [...floorBlock[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]])
  assert.ok(floor.length > 0, 'FLOOR parsed empty')

  const { VALIDATE_STEPS } = await import(join(TEMPLATE, 'base/tools/harness.config.mjs'))
  assert.deepEqual(
    VALIDATE_STEPS,
    floor,
    'tools/validate.mjs FLOOR and tools/harness.config.mjs VALIDATE_STEPS must be identical (names and commands, in order)',
  )
})

test('npm pack ships every template path (dotless storage survives packing)', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const critical of [
    'template/base/.claude/settings.json',
    'template/base/.claude/hooks/stop-validate-gate.mjs',
    'template/base/gitignore',
    'template/base/package.json.tmpl',
    'template/base/tools/harness.config.mjs',
    'template/stack/apps/desktop/src-tauri/tauri.conf.json',
    'template/stack/packages/schema/drizzle/0000_init.sql',
    'installer/cli.mjs',
  ]) {
    assert.ok(files.includes(critical), `npm pack dropped ${critical}`)
  }
})
