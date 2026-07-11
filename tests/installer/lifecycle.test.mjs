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
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// Residue scanning goes through the ONE shared scanner (scripts/check-residue.mjs)
// — the selftest lanes run the same script, so the residue definition cannot fork.
const RESIDUE = fileURLToPath(new URL('../../scripts/check-residue.mjs', import.meta.url))
function placeholderResidue(dir) {
  const res = spawnSync('node', [RESIDUE, dir], { encoding: 'utf8' })
  if (res.status === 0) return []
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(1)
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

  // Manifest keys are POSIX on every OS — path.win32.join separators broke
  // every prefix-based mode rule and made manifests non-portable (v0.1.1 bug
  // class). This assertion is load-bearing on the windows-latest CI leg.
  const backslashed = Object.keys(manifest.files).filter((k) => k.includes('\\'))
  assert.deepEqual(backslashed, [], 'manifest keys must use POSIX separators on every OS')
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

test('retrofit non-clobber is universal: project memory, ignore rules, settings, compose, workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-retro2-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'existing', dependencies: { hono: '^4.0.0' } }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(dir, 'apps/server'), { recursive: true })
  writeFileSync(join(dir, 'apps/server/package.json'), '{"name":"server"}\n')

  const theirAgents = '# My project memory\nDo not touch.\n'
  writeFileSync(join(dir, 'AGENTS.md'), theirAgents)
  const theirCompose = 'services:\n  api:\n    image: theirs\n'
  writeFileSync(join(dir, 'docker-compose.yml'), theirCompose)
  writeFileSync(join(dir, '.gitignore'), '# mine\nnode_modules/\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(
    join(dir, '.claude/settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(make test)'], defaultMode: 'default' } }, null, 2),
  )
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  const theirWorkflow = 'name: theirs\non: push\njobs: {}\n'
  writeFileSync(join(dir, '.github/workflows/quality-gate.yml'), theirWorkflow)

  const r = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(r.code, 2, r.out)

  // Byte-preserved: their project memory, compose file, and workflow.
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), theirAgents)
  assert.equal(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), theirCompose)
  assert.equal(readFileSync(join(dir, '.github/workflows/quality-gate.yml'), 'utf8'), theirWorkflow)
  // Ours parked OUTSIDE active paths (a sibling in workflows/ would execute).
  for (const parked of [
    '.harness/conflicts/AGENTS.md',
    '.harness/conflicts/docker-compose.yml',
    '.harness/conflicts/.github/workflows/quality-gate.yml',
  ]) {
    assert.ok(existsSync(join(dir, parked)), `missing parked copy: ${parked}`)
  }

  // .gitignore merged: theirs kept, harness patterns appended.
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  assert.ok(gi.startsWith('# mine\nnode_modules/\n'), gi)
  assert.ok(gi.includes('.dev-auth/'), 'harness ignore patterns must be appended')

  // .claude/settings.json merged: their permission posture kept, hooks wired.
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.permissions.defaultMode, 'default')
  assert.ok(settings.permissions.allow.includes('Bash(make test)'))
  assert.ok(JSON.stringify(settings.hooks).includes('stop-validate-gate'), 'Stop hook must be wired')
})

test('re-running init on an installed project is refused; --force re-renders with carried answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-reinit-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Tune an owned file, then attempt re-init: must refuse before touching anything.
  const tuned = join(dir, 'tools/harness.config.mjs')
  const tunedContent = `${readFileSync(tuned, 'utf8')}// tuned\n`
  writeFileSync(tuned, tunedContent)
  const again = run(['init', '--dir', dir, '--yes', ...SETS])
  assert.equal(again.code, 1, again.out)
  assert.ok(again.out.includes('already has a harness'), again.out)
  assert.equal(readFileSync(tuned, 'utf8'), tunedContent, 'refused init must not touch files')

  // --force re-renders; prior answers carry over without repeating --set.
  const forced = run(['init', '--dir', dir, '--yes', '--force'])
  assert.equal(forced.code, 0, forced.out)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'fixture-app', 'answers must carry over from the prior manifest')

  // Corrupt manifest: never advise re-init.
  writeFileSync(join(dir, '.harness/manifest.json'), '{ corrupted')
  const broken = run(['doctor', '--dir', dir])
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('restore it from git'), broken.out)
  const initOnCorrupt = run(['init', '--dir', dir, '--yes'])
  assert.equal(initOnCorrupt.code, 1)
  assert.ok(initOnCorrupt.out.includes('restore it from git'), initOnCorrupt.out)
})

test('init rejects invalid placeholder values, unknown --set keys, unknown tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-val-'))

  const longId = run(['init', '--dir', dir, '--yes', ...SETS,
    '--set', 'PRODUCT_IDENTIFIER=com.example.a-very-long-identifier-that-breaks-msi'])
  assert.equal(longId.code, 1, longId.out)
  assert.ok(longId.out.includes('30'), longId.out)
  assert.ok(!existsSync(join(dir, 'package.json')), 'nothing may be written on invalid answers')

  const badOrigin = run(['init', '--dir', dir, '--yes', ...SETS, '--set', 'API_ORIGIN=api.example.com/v1'])
  assert.equal(badOrigin.code, 1, badOrigin.out)
  assert.ok(badOrigin.out.includes('connect-src'), badOrigin.out)

  const unknownSet = run(['init', '--dir', dir, '--yes', ...SETS, '--set', 'TYPO_VAR=x'])
  assert.equal(unknownSet.code, 1, unknownSet.out)
  assert.ok(unknownSet.out.includes('unknown placeholder'), unknownSet.out)

  const badTier = run(['init', '--dir', dir, '--yes', '--tier', 'strictest', ...SETS])
  assert.equal(badTier.code, 1, badTier.out)
  assert.ok(badTier.out.includes('unknown tier'), badTier.out)
})

test('enable: dry-run writes nothing, binary assets survive, drift is parked not clobbered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-enable-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)

  // dry-run: reports but writes nothing, manifest unchanged.
  const before = readFileSync(join(dir, '.harness/manifest.json'), 'utf8')
  const dry = run(['enable', 'gate-a11y-deep', '--dir', dir, '--dry-run'])
  assert.equal(dry.code, 0, dry.out)
  assert.equal(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'), before, 'dry-run must not touch the manifest')

  // real enable, then disable round-trips (raw-byte hashing must hold for any
  // binary assets a module ships).
  const en = run(['enable', 'gate-a11y-deep', '--dir', dir])
  assert.equal(en.code, 0, en.out)
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(manifest.modules.includes('gate-a11y-deep'))
  const moduleFiles = Object.entries(manifest.files).filter(([, m]) => m.module === 'gate-a11y-deep')
  assert.ok(moduleFiles.length > 0, 'enable must record module files')

  // Locally modify one module file, re-enable: local content kept, incoming parked.
  const [modRel] = moduleFiles.find(([ip]) => ip.endsWith('.mjs')) ?? moduleFiles[0]
  const modAbs = join(dir, modRel)
  const localContent = `${readFileSync(modAbs, 'utf8')}\n// local tuning\n`
  writeFileSync(modAbs, localContent)
  const re = run(['enable', 'gate-a11y-deep', '--dir', dir])
  assert.equal(re.code, 0, re.out)
  assert.equal(readFileSync(modAbs, 'utf8'), localContent, 're-enable must not clobber local changes')
  assert.ok(existsSync(join(dir, '.harness/pending', modRel)), 'incoming module version must be parked')

  const dis = run(['disable', 'gate-a11y-deep', '--dir', dir])
  assert.equal(dis.code, 0, dis.out)
  const after = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.ok(!after.modules.includes('gate-a11y-deep'))
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

test('backslash manifest keys: doctor trips, update heals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-bslash-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Simulate a manifest written by a pre-0.1.3 Windows install: rewrite one
  // seeded and one owned key with Windows separators.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const key of ['apps/server/src/app.ts', 'tools/validate.mjs']) {
    manifest.files[key.split('/').join('\\')] = manifest.files[key]
    delete manifest.files[key]
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // doctor: hard error (exit 1) naming the migration path.
  const doc = run(['doctor', '--dir', dir])
  assert.equal(doc.code, 1, doc.out)
  assert.ok(doc.out.includes('Windows-separator'), doc.out)

  // update: rewrites the keys to POSIX; a follow-up doctor is quiet about
  // separators and the owned file keeps drift protection under its POSIX key.
  const upd = run(['update', '--dir', dir])
  assert.notEqual(upd.code, 1, upd.out)
  const healed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(
    Object.keys(healed.files).filter((k) => k.includes('\\')),
    [],
    'update must rewrite backslash keys to POSIX',
  )
  assert.ok(healed.files['apps/server/src/app.ts'], 'healed seeded key must survive under POSIX form')
  const docAfter = run(['doctor', '--dir', dir])
  assert.ok(!docAfter.out.includes('Windows-separator'), docAfter.out)
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
  let moduleName = 'gate-a11y-deep'
  if (!existsSync(join(modulesRoot, moduleName))) {
    const available = existsSync(modulesRoot)
      ? readdirSync(modulesRoot).filter((e) => statSync(join(modulesRoot, e)).isDirectory())
      : []
    if (available.length === 0) {
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

test('refresh-seeded: overwrite when untouched, park on drift, error on unknown path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-refresh-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const ip = 'apps/desktop/src/App.tsx'
  const abs = join(dir, ip)
  const templateContent = readFileSync(abs, 'utf8')

  // Simulate "installed by an older template, untouched since": plant old
  // content AND record its sha as the installed state.
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const oldContent = '// old template version\n'
  writeFileSync(abs, oldContent)
  manifest.files[ip].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const refreshed = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(refreshed.code, 0, refreshed.out)
  assert.equal(readFileSync(abs, 'utf8'), templateContent, 'untouched seeded file must refresh to the template version')
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.files[ip].mode, 'seeded', 'mode must stay seeded after refresh')

  // Local drift: kept, template version parked.
  const localWork = `${templateContent}\n// my project's real work\n`
  writeFileSync(abs, localWork)
  const parked = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(readFileSync(abs, 'utf8'), localWork, 'local changes must never be clobbered')
  assert.ok(existsSync(join(dir, '.harness/pending', ip)), 'template version must be parked')
  assert.ok(parked.out.includes('parked'), parked.out)

  // Unknown path: loud error with candidates.
  const unknown = run(['update', '--dir', dir, '--refresh-seeded', 'apps/desktop/App.tsx'])
  assert.equal(unknown.code, 1, unknown.out)
  assert.ok(unknown.out.includes('did you mean'), unknown.out)
  assert.ok(unknown.out.includes(ip), unknown.out)
})

test('doctor: seeded divergence from the current template is an info advisory, never an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-seedadv-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  writeFileSync(join(dir, 'apps/desktop/src/App.tsx'), '// project rewrote its app\n')
  const r = run(['doctor', '--dir', dir])
  assert.notEqual(r.code, 1, r.out)
  assert.ok(r.out.includes('refresh-seeded'), r.out)
  assert.ok(r.out.includes('apps/desktop/src/App.tsx'), r.out)
})

test('update survives a manifest that still lists a RETIRED module (0.1.1 → now)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-retiredup-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.modules = [...(manifest.modules ?? []), 'gate-styleguide', 'gate-perf-budget']
  manifest.harnessVersion = '0.1.1'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const r = run(['update', '--dir', dir])
  // The guard against planning a retired module's deleted template dir must
  // hold at ANY version — this crash was the bug.
  assert.notEqual(r.code, 1, r.out)

  // Pruning itself is applied by the "0.1.3" migration record, which only
  // activates once the installer version reaches it (release bump). Assert
  // version-aware so this test tightens automatically at the bump; the
  // machinery is unit-covered in migrations.test.mjs either way.
  const pkgVersion = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ).version
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bumped = pkgVersion
    .split('.')
    .map(Number)
    .reduce((acc, n, i) => acc + n * 1000 ** (2 - i), 0) >= 1003 // >= 0.1.3
  if (bumped) {
    assert.ok(!after.modules.includes('gate-styleguide'), 'promoted module must be pruned from the module list')
    assert.ok(!after.modules.includes('gate-perf-budget'), 'promoted module must be pruned from the module list')
  } else {
    assert.ok(after.modules.includes('gate-styleguide'), 'pre-bump: migration record not yet active — update must still succeed')
  }
})

test('enable of a retired (promoted) module fails with the promotion story, not "unknown"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-retired-'))
  assert.equal(run(['init', '--dir', dir, '--yes', '--tier', 'core', ...SETS]).code, 0)
  for (const name of ['gate-styleguide', 'gate-perf-budget']) {
    const res = run(['enable', name, '--dir', dir])
    assert.equal(res.code, 1, res.out)
    assert.ok(res.out.includes('promoted into the default gate chain'), res.out)
    assert.ok(res.out.includes('update'), res.out)
  }
})

test('the template ships validate.floor.json in lockstep with VALIDATE_STEPS', async () => {
  // The CI floor is now the frozen snapshot tools/validate.floor.json (its
  // fail-closed + append semantics are pinned in tests/gates/floor-lockstep.test.mjs);
  // the installer's concern is that the template actually ships it and it matches.
  const floorPath = join(TEMPLATE, 'base/tools/validate.floor.json')
  assert.ok(existsSync(floorPath), 'template must ship tools/validate.floor.json (the CI floor)')
  const snapshot = JSON.parse(readFileSync(floorPath, 'utf8'))
  // file:// URL, not the raw path — Windows absolute paths (D:\…) are not
  // importable by the ESM loader.
  const { VALIDATE_STEPS } = await import(
    pathToFileURL(join(TEMPLATE, 'base/tools/harness.config.mjs')).href
  )
  assert.deepEqual(
    snapshot.steps,
    VALIDATE_STEPS,
    'tools/validate.floor.json and tools/harness.config.mjs VALIDATE_STEPS must be identical (regenerate with `node scripts/generate-floor.mjs --write`)',
  )
})

test('npm pack ships every template path (dotless storage survives packing)', () => {
  // shell: true — on Windows npm is a .cmd shim that a shell-less spawn cannot
  // execute (ENOENT bare / EINVAL as npm.cmd under Node's CVE-2024-27980
  // hardening). Args are static, so shell interpolation is a non-issue.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    shell: true,
  })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const critical of [
    'template/base/.claude/settings.json',
    'template/base/.claude/hooks/stop-validate-gate.mjs',
    'template/base/gitignore',
    'template/base/package.json.tmpl',
    'template/base/tools/harness.config.mjs',
    'template/base/tools/validate.floor.json',
    'template/stack/apps/desktop/src-tauri/tauri.conf.json',
    'template/stack/packages/schema/drizzle/0000_init.sql',
    'installer/cli.mjs',
  ]) {
    assert.ok(files.includes(critical), `npm pack dropped ${critical}`)
  }
})

// ── v0.1.4 Stage 1c: regression armor for the just-landed update/refresh
// refactor. These pin CURRENT behavior of the --force sweep, refresh-seeded
// unknown-path reporting, park-on-drift idempotence, and dry-run plan parity. ──

test('update --force overwrites a drifted OWNED file, notes it, and re-records the sha', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-force-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // A locally-modified owned hook: without --force this parks (exit 2); with
  // --force the incoming template version wins in place.
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const templateContent = readFileSync(owned, 'utf8')
  writeFileSync(owned, `${templateContent}\n// local tweak that force must overwrite\n`)

  const forced = run(['update', '--dir', dir, '--force'])
  assert.equal(forced.code, 0, forced.out) // deliberate overwrite → clean exit
  const restored = readFileSync(owned, 'utf8')
  assert.equal(restored, templateContent, '--force must restore the template version in place')
  assert.ok(!restored.includes('// local tweak'), 'local drift must be gone after --force')
  assert.ok(forced.out.includes(`--force overwrote locally-modified ${ownedRel}`), forced.out)

  // Manifest hash must track the overwrite, so a follow-up doctor is clean.
  const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))
  assert.equal(
    manifest.files[ownedRel].sha256,
    sha256(restored),
    'manifest sha must be re-recorded to the written content',
  )
  assert.equal(run(['doctor', '--dir', dir]).code, 0, 'forced overwrite must leave a clean install')
})

test('refresh-seeded unknown path: non-zero via return (not a throw), near-candidate suggestions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-refunk-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Near miss: wrong directory, right basename → the note names the real path.
  const near = run(['update', '--dir', dir, '--refresh-seeded', 'desktop/App.tsx'])
  assert.equal(near.code, 1, near.out)
  assert.ok(near.out.includes('did you mean'), near.out)
  assert.ok(near.out.includes('apps/desktop/src/App.tsx'), near.out)
  // A non-zero RETURN, not a thrown error — the CLI prefixes "error:" only when
  // update throws (e.g. missing manifest); a bad path must not read that way.
  assert.ok(!near.out.includes('error:'), 'unknown path must exit via code, not throw')

  // No basename match anywhere → the miss is reported WITHOUT a "did you mean".
  const orphan = run(['update', '--dir', dir, '--refresh-seeded', 'no-such-file.zzz'])
  assert.equal(orphan.code, 1, orphan.out)
  assert.ok(orphan.out.includes('no template file installs to no-such-file.zzz'), orphan.out)
  assert.ok(!orphan.out.includes('did you mean'), 'a candidate-less miss must not fabricate a suggestion')

  // Batch with one good + one bad path: the good one is still applied in full,
  // but a single miss fails the whole invocation (exit 1).
  const seededRel = 'apps/server/src/app.ts'
  const seededAbs = join(dir, seededRel)
  const seededTemplate = readFileSync(seededAbs, 'utf8')
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const oldContent = '// installed by an older template\n'
  writeFileSync(seededAbs, oldContent)
  manifest.files[seededRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const batch = run(['update', '--dir', dir,
    '--refresh-seeded', seededRel,
    '--refresh-seeded', 'no-such-file.zzz'])
  assert.equal(batch.code, 1, batch.out) // any miss fails the batch
  assert.equal(
    readFileSync(seededAbs, 'utf8'),
    seededTemplate,
    'the valid path in a partly-bad batch is still refreshed',
  )
})

test('refresh-seeded park-on-drift is idempotent: re-running never clobbers and never flip-flops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-refidem-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  const ip = 'apps/desktop/src/App.tsx'
  const abs = join(dir, ip)
  const templateContent = readFileSync(abs, 'utf8')
  const localWork = `${templateContent}\n// my project's real work\n`
  writeFileSync(abs, localWork)

  const manifestPath = join(dir, '.harness/manifest.json')
  const recordedSha = JSON.parse(readFileSync(manifestPath, 'utf8')).files[ip].sha256
  const pendingPath = join(dir, '.harness/pending', ip)

  const snapshot = () => ({
    file: readFileSync(abs, 'utf8'),
    pending: readFileSync(pendingPath),
    sha: JSON.parse(readFileSync(manifestPath, 'utf8')).files[ip].sha256,
  })

  const first = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(first.code, 2, first.out) // drift → exit 2
  assert.ok(first.out.includes('parked'), first.out)
  const afterFirst = snapshot()
  assert.equal(afterFirst.file, localWork, 'local work must survive the park')
  assert.equal(afterFirst.pending.toString('utf8'), templateContent, 'the template version is what gets parked')
  assert.equal(afterFirst.sha, recordedSha, 'park must NOT re-record the manifest sha')

  // Re-run with nothing changed: same exit, same bytes everywhere — no flip-flop.
  const second = run(['update', '--dir', dir, '--refresh-seeded', ip])
  assert.equal(second.code, 2, second.out)
  const afterSecond = snapshot()
  assert.equal(afterSecond.file, afterFirst.file, 're-run must not touch local work')
  assert.deepEqual(afterSecond.pending, afterFirst.pending, 're-run must re-park identical bytes')
  assert.equal(afterSecond.sha, afterFirst.sha, 're-run must not drift the recorded sha')
})

test('update --dry-run touches nothing yet reports byte-for-byte the plan the real run applies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-dryplan-'))
  assert.equal(run(['init', '--dir', dir, '--yes', ...SETS]).code, 0)

  // Stage a REFRESH: an owned file installed by an older harness (content
  // differs from the template) but recorded as untouched (sha matches disk).
  const ownedRel = '.claude/hooks/posttool-fast-check.mjs'
  const owned = join(dir, ownedRel)
  const oldContent = '#!/usr/bin/env node\n// older harness build\n'
  writeFileSync(owned, oldContent)
  const manifestPath = join(dir, '.harness/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files[ownedRel].sha256 = sha256(oldContent)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const fileBefore = readFileSync(owned, 'utf8')
  const manifestBefore = readFileSync(manifestPath, 'utf8')

  // Slice the JSON payload out of combined stdout/stderr — robust to any
  // interpreter noise around it.
  const parseReport = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))

  // Dry-run: emits the plan, writes nothing.
  const dry = run(['update', '--dir', dir, '--dry-run', '--report', 'json'])
  assert.equal(dry.code, 0, dry.out)
  const dryReport = parseReport(dry.out)
  assert.ok(dryReport.written.includes(ownedRel), 'dry-run plan must list the refresh')
  assert.equal(readFileSync(owned, 'utf8'), fileBefore, 'dry-run must not touch the file')
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore, 'dry-run must not touch the manifest')
  assert.ok(!existsSync(join(dir, '.harness/pending')), 'dry-run must not create pending/')

  // Real run: identical report object, now actually applied on disk.
  const real = run(['update', '--dir', dir, '--report', 'json'])
  assert.equal(real.code, 0, real.out)
  const realReport = parseReport(real.out)
  assert.deepEqual(dryReport, realReport, 'dry-run must report exactly the plan the real run executes')
  assert.notEqual(readFileSync(owned, 'utf8'), oldContent, 'the real run must refresh the file')
  const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(
    manifestAfter.files[ownedRel].sha256,
    sha256(readFileSync(owned, 'utf8')),
    'real run must re-record the sha',
  )
})
