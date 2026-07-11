// Can-fail proofs for the provenance gate (template/base/tools/check-sources.mjs).
// v0.1.1 was presence-only: ANY text after `SOURCE:` passed, `[corpus: <id>]` refs
// were never resolved, and the corpus carried empty sha256 fields. Every rule here
// is fixture-driven: build a scaffold-shaped git tree (the gate enumerates via
// `git ls-files` and reads tools/mcp/corpus/index.json from CWD, but imports its
// rules lib relative to its own file), run the real gate with cwd inside it,
// assert the exact red/green.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const GATE = fileURLToPath(new URL('../../template/base/tools/check-sources.mjs', import.meta.url))
const SHIPPED_CORPUS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/mcp/corpus/index.json', import.meta.url)),
  'utf8',
)

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
}

// Minimal scaffold-shaped fixture: a git index (the gate scans `git ls-files`
// relative to cwd) plus a corpus copy where the gate reads it FROM CWD.
function fixture({ files = {}, corpus = SHIPPED_CORPUS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-srcgate-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'tools/mcp/corpus'), { recursive: true })
  writeFileSync(join(dir, 'tools/mcp/corpus/index.json'), corpus)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A')
  return dir
}

function runGate(dir) {
  const res = spawnSync('node', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the backfill proof: a real rendered scaffold is green ─────────────────────
let scaffold

before(() => {
  scaffold = mkdtempSync(join(tmpdir(), 'tpah-srcgate-scaffold-'))
  const res = spawnSync(
    'node',
    [
      CLI, 'init', '--dir', scaffold, '--yes',
      '--set', 'PROJECT_NAME=Provenance App',
      '--set', 'GITHUB_OWNER=fixture-owner',
      '--set', 'SECURITY_OWNERS=@fixture-owner/security',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
  git(scaffold, 'init', '-q')
  git(scaffold, 'add', '-A')
})

test('GREEN: a rendered scaffold passes — every cited corpus id resolves, hashes are real, all groups covered', () => {
  const r = runGate(scaffold)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('corpus verified'), r.out)
  assert.ok(r.out.includes('6/6 decision groups covered'), r.out)
})

// ── decision-site presence (hook parity) ──────────────────────────────────────
test('RED: an uncited decision site fails naming file:line', () => {
  const r = runGate(fixture({
    files: { 'apps/server/src/auth.ts': 'const claims = await jwtVerify(token, jwks)\n' },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:1'), r.out)
  assert.ok(r.out.includes('lack an inline'), r.out)
})

// ── citation resolvability ────────────────────────────────────────────────────
test('RED: a SOURCE citing an unknown corpus id fails naming file, line, and id', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: pinned in corpus [corpus: nonexistent/id]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:1'), r.out)
  assert.ok(r.out.includes('[corpus: nonexistent/id] does not resolve'), r.out)
})

test('RED: a SOURCE payload with no URL, no existing path, no corpus ref (presence-only prose)', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: trust me\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('SOURCE payload resolves to nothing'), r.out)
  assert.ok(r.out.includes('trust me'), r.out)
})

test('GREEN: payloads ground via https URL, existing repo-relative path, or corpus id (multi-line comments too)', () => {
  const r = runGate(fixture({
    files: {
      'docs/decisions.md': '# decisions\n',
      'apps/server/src/auth.ts': [
        '// SOURCE: https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens',
        'const claims = await jwtVerify(token, jwks)',
        '// SOURCE: rationale recorded in docs/decisions.md',
        'const tolerance = { clockTolerance: 300 }',
        '// SOURCE: jose is the reference implementation — the corpus tail lands on',
        '// a continuation line, like real wrapped citations [corpus: entra/jwt-verify]',
        'const keys = createRemoteJWKSet(url)',
        '',
      ].join('\n'),
    },
  }))
  assert.equal(r.code, 0, r.out)
})

// ── corpus integrity: tamper-evident data ─────────────────────────────────────
test('RED: a tampered corpus sha256 fails with the tamper-evidence message', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  corpus[0].sha256 = '0'.repeat(64)
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes(`corpus entry ${corpus[0].id} text/hash mismatch — the corpus is tamper-evident data`),
    r.out,
  )
})

test('RED: a corpus entry with empty url/version fails loud (malformed entries never pass)', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  corpus[1].url = ''
  corpus[1].version = ''
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`corpus entry ${corpus[1].id}: missing/empty url`), r.out)
  assert.ok(r.out.includes(`corpus entry ${corpus[1].id}: missing/empty version`), r.out)
})

// ── depth lockstep: every decision group needs an authorizing corpus entry ────
test('RED: stripping all groups tags fails naming every uncovered decision group', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  for (const e of corpus) delete e.groups
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  for (const key of [
    'rls-policy', 'guc-identity', 'token-verification',
    'vector-index', 'llm-sampling', 'tuning-constants',
  ]) {
    assert.ok(r.out.includes(`decision group '${key}'`), `${key}: ${r.out}`)
  }
})

test('RED: a missing corpus index is a broken provenance surface, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-srcgate-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/server/src/auth.ts'),
    '// SOURCE: entra docs [corpus: entra/jwt-verify]\nconst claims = await jwtVerify(token, jwks)\n',
  )
  git(dir, 'add', '-A')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/mcp/corpus/index.json: missing'), r.out)
})

// ── scope: docs placeholders are not references ───────────────────────────────
test('GREEN: `[corpus: <id>]` documentation placeholders never parse as references', () => {
  const r = runGate(fixture({
    files: { 'docs/howto.md': 'Cite as `// SOURCE: <authority> [corpus: <id>]` on the line above.\n' },
  }))
  assert.equal(r.code, 0, r.out)
})
