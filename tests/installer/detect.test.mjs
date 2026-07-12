// Unit tests for target-directory detection (installer/lib/detect.mjs):
// bootstrap vs retrofit classification, foreign-stack / foreign-lockfile /
// non-workspace rejections with actionable guidance, and git-remote owner
// inference in detectContext. Pins the just-landed v0.1.4 refactor's ACTUAL
// behavior as regression armor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { detect, detectContext } from '../../installer/lib/detect.mjs'

const dir = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const writePkg = (d, pkg) => writeFileSync(join(d, 'package.json'), JSON.stringify(pkg))

const git = (d, args) =>
  execFileSync('git', ['-C', d, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

// ---------------------------------------------------------------------------
// detect(): bootstrap classification
// ---------------------------------------------------------------------------

test('empty dir → bootstrap, empty: true', () => {
  const d = dir('tpah-det-empty-')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('non-existent dir → bootstrap, empty: true', () => {
  const d = join(dir('tpah-det-miss-'), 'does-not-exist')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('dir with only .git and .DS_Store still counts as empty', () => {
  const d = dir('tpah-det-gitonly-')
  mkdirSync(join(d, '.git'))
  writeFileSync(join(d, '.DS_Store'), '')
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: true })
})

test('non-empty dir WITHOUT package.json → bootstrap, empty: false (current behavior: no throw)', () => {
  const d = dir('tpah-det-nonempty-')
  writeFileSync(join(d, 'README.md'), '# stuff\n')
  mkdirSync(join(d, 'src'))
  assert.deepEqual(detect(d), { mode: 'bootstrap', empty: false })
})

// ---------------------------------------------------------------------------
// detect(): rejections
// ---------------------------------------------------------------------------

test('package.json with a `next` dependency throws with the redirect story', () => {
  const d = dir('tpah-det-next-')
  writePkg(d, { name: 'x', dependencies: { next: '16.0.0' } })
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /Tauri 2 \+ Hono/)
      assert.match(err.message, /next-supabase-agent-harness/)
      return true
    },
  )
})

test('`next` in devDependencies is rejected too (deps and devDeps are merged)', () => {
  const d = dir('tpah-det-nextdev-')
  writePkg(d, { name: 'x', devDependencies: { next: '16.0.0' } })
  assert.throws(() => detect(d), /Tauri 2 \+ Hono/)
})

test('each foreign lockfile throws, naming the lockfile and the pnpm migration path', () => {
  for (const lock of ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    const d = dir('tpah-det-lock-')
    writePkg(d, { name: 'x' })
    writeFileSync(join(d, lock), '')
    assert.throws(
      () => detect(d),
      (/** @type {Error} */ err) => {
        assert.ok(err.message.includes(lock), `message must name ${lock}: ${err.message}`)
        assert.match(err.message, /requires pnpm/)
        assert.match(err.message, /pnpm import/)
        return true
      },
    )
  }
})

test('pnpm-lock.yaml is NOT a foreign lockfile — falls through to the workspace check', () => {
  const d = dir('tpah-det-pnpmlock-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  assert.throws(() => detect(d), /no pnpm-workspace\.yaml/)
})

test('the `next` rejection wins over the lockfile rejection (check order pinned)', () => {
  const d = dir('tpah-det-order-')
  writePkg(d, { name: 'x', dependencies: { next: '16.0.0' } })
  writeFileSync(join(d, 'package-lock.json'), '{}')
  assert.throws(() => detect(d), /Tauri 2 \+ Hono/)
})

test('package.json without pnpm-workspace.yaml throws with the monorepo-shape guidance', () => {
  const d = dir('tpah-det-nows-')
  writePkg(d, { name: 'x', dependencies: { hono: '^4.0.0' } })
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /no pnpm-workspace\.yaml/)
      assert.ok(err.message.includes('apps/*, packages/*'), err.message)
      return true
    },
  )
})

test('pnpm workspace without tauri or hono markers throws with layout guidance', () => {
  const d = dir('tpah-det-nomark-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  assert.throws(
    () => detect(d),
    (/** @type {Error} */ err) => {
      assert.ok(err.message.includes('apps/desktop/src-tauri/tauri.conf.json'), err.message)
      assert.ok(err.message.includes('apps/server'), err.message)
      assert.match(err.message, /configurable-layout/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// detect(): valid retrofit trees
// ---------------------------------------------------------------------------

test('retrofit: tauri.conf.json marker alone → hasTauri true, hasHono false, pkg round-trips', () => {
  const d = dir('tpah-det-tauri-')
  const pkg = { name: 'their-app', private: true }
  writePkg(d, pkg)
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(d, 'apps/desktop/src-tauri'), { recursive: true })
  writeFileSync(join(d, 'apps/desktop/src-tauri/tauri.conf.json'), '{}')
  assert.deepEqual(detect(d), { mode: 'retrofit', pkg, hasTauri: true, hasHono: false })
})

test('retrofit: hono root dependency alone → hasHono true, hasTauri false', () => {
  const d = dir('tpah-det-honodep-')
  writePkg(d, { name: 'x', dependencies: { hono: '^4.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasTauri, false)
  assert.equal(r.hasHono, true)
})

test('retrofit: apps/server/package.json alone marks hasHono even without a hono dep', () => {
  const d = dir('tpah-det-srvpkg-')
  writePkg(d, { name: 'x' })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(d, 'apps/server'), { recursive: true })
  writeFileSync(join(d, 'apps/server/package.json'), '{"name":"server"}')
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasTauri, false)
  assert.equal(r.hasHono, true)
})

test('retrofit: both markers present → hasTauri and hasHono both true', () => {
  const d = dir('tpah-det-both-')
  writePkg(d, { name: 'x', devDependencies: { hono: '^4.0.0' } })
  writeFileSync(join(d, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n")
  mkdirSync(join(d, 'apps/desktop/src-tauri'), { recursive: true })
  writeFileSync(join(d, 'apps/desktop/src-tauri/tauri.conf.json'), '{}')
  const r = detect(d)
  assert.equal(r.mode, 'retrofit')
  assert.equal(r.hasTauri, true)
  assert.equal(r.hasHono, true)
})

// ---------------------------------------------------------------------------
// detect(): unreadable / corrupt package.json
// ---------------------------------------------------------------------------

test('corrupt package.json throws the unreadable error', () => {
  const d = dir('tpah-det-corrupt-')
  writeFileSync(join(d, 'package.json'), '{ this is not json')
  assert.throws(() => detect(d), /unreadable package\.json/)
})

test('package.json that cannot be read as a file (a directory) throws the unreadable error', () => {
  const d = dir('tpah-det-eisdir-')
  mkdirSync(join(d, 'package.json'))
  assert.throws(() => detect(d), /unreadable package\.json/)
})

// ---------------------------------------------------------------------------
// detectContext(): git-remote owner inference
// ---------------------------------------------------------------------------

test('detectContext: ssh remote → gitOwner parsed from git@host:owner/repo.git', () => {
  const d = dir('tpah-ctx-ssh-')
  git(d, ['init', '-q'])
  git(d, ['remote', 'add', 'origin', 'git@github.com:acme-owner/some-repo.git'])
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, 'acme-owner')
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})

test('detectContext: https remote → gitOwner parsed, with or without the .git suffix', () => {
  const withGit = dir('tpah-ctx-https-')
  git(withGit, ['init', '-q'])
  git(withGit, ['remote', 'add', 'origin', 'https://github.com/acme-owner/some-repo.git'])
  assert.equal(detectContext(withGit).gitOwner, 'acme-owner')

  const bare = dir('tpah-ctx-httpsbare-')
  git(bare, ['init', '-q'])
  git(bare, ['remote', 'add', 'origin', 'https://github.com/acme-owner/some-repo'])
  assert.equal(detectContext(bare).gitOwner, 'acme-owner')
})

test('detectContext: git repo without an origin remote → gitOwner null', () => {
  const d = dir('tpah-ctx-noremote-')
  git(d, ['init', '-q'])
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, null)
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})

test('detectContext: not a git repo at all → gitOwner null, defaults intact', () => {
  const d = dir('tpah-ctx-nogit-')
  const ctx = detectContext(d)
  assert.equal(ctx.gitOwner, null)
  assert.equal(ctx.dirName, basename(d))
  assert.deepEqual(ctx.answers, {})
})
