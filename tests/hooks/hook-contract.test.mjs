// Contract tests for the shipped Claude Code hooks: pipe hook-event JSON to
// stdin, assert exit codes and deny/block behavior. Hooks are tested from a
// rendered install layout (hooks import ../../tools/harness.config.mjs).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEMPLATE = new URL('../../template/base/', import.meta.url).pathname
let proj

before(() => {
  proj = mkdtempSync(join(tmpdir(), 'nsah-hooks-'))
  cpSync(join(TEMPLATE, '.claude'), join(proj, '.claude'), { recursive: true })
  mkdirSync(join(proj, 'tools'), { recursive: true })
})

function runHook(name, input, { env = {}, cwd = proj } = {}) {
  const res = spawnSync('node', [join(proj, '.claude/hooks', name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const denied = (r) => r.stdout.includes('deny') || r.code === 2

// ── bash-guard ────────────────────────────────────────────────────────────────
for (const cmd of [
  'rm -rf node_modules',
  'git push --force origin main',
  'git reset --hard HEAD~1',
  'cat .env.local',
  'echo $SUPABASE_' + 'SERVICE_ROLE_KEY',
]) {
  test(`bash-guard denies: ${cmd}`, () => {
    assert.ok(denied(runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })), cmd)
  })
}

test('bash-guard passes a benign command', () => {
  const r = runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'pnpm validate' } })
  assert.equal(r.code, 0)
  assert.ok(!r.stdout.includes('deny'), r.stdout)
})

// ── write-guard ───────────────────────────────────────────────────────────────
test('write-guard denies a DAL module missing the server-only wall', () => {
  const r = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'lib/dal/notes.ts', content: 'export const x = 1\n' },
  })
  assert.ok(denied(r), r.stdout)
})

test('write-guard passes a DAL module carrying the wall', () => {
  const r = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'lib/dal/notes.ts', content: "import 'server-only'\nexport const x = 1\n" },
  })
  assert.ok(!denied(r), r.stdout)
})

test('write-guard denies service-role references in app code', () => {
  const r = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'app/x.ts', content: 'const k = process.env.SUPABASE_' + 'SERVICE_ROLE_KEY\n' },
  })
  assert.ok(denied(r), r.stdout)
})

test('write-guard exempts tests/', () => {
  const r = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'tests/rls/probe.ts', content: 'const k = process.env.SUPABASE_' + 'SERVICE_ROLE_KEY\n' },
  })
  assert.ok(!denied(r), r.stdout)
})

test('write-guard protects the gate config from agent edits', () => {
  const r = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'tools/harness.config.mjs', content: 'export const VALIDATE_STEPS = []\n' },
  })
  assert.ok(denied(r), 'harness.config.mjs must be write-protected')
})

test('write-guard allows gate-config edits with HARNESS_ALLOW_SELF_EDIT=1', () => {
  const r = runHook(
    'pretool-write-guard.mjs',
    { tool_input: { file_path: 'tools/harness.config.mjs', content: 'export const VALIDATE_STEPS = []\n' } },
    { env: { HARNESS_ALLOW_SELF_EDIT: '1' } },
  )
  assert.ok(!denied(r), r.stdout)
})

test('write-guard protects the whole lint/architecture + permission surface', () => {
  for (const f of [
    'eslint.config.mjs',
    'eslint/harness.eslint.mjs',
    'biome.jsonc',
    'knip.json',
    '.dependency-cruiser.js',
    'tsconfig.json',
    '.mcp.json',
    '.claude/settings.local.json',
    'tests/rls/run-rls.mjs',
    'tools/validate.mjs',
  ]) {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: f, content: 'x\n' } })
    assert.ok(denied(r), `${f} must be write-protected`)
  }
})

test('write-guard does NOT false-positive on ordinary nested project files', () => {
  for (const f of [
    'app/components/knip.json', // not the root config
    'node_modules/pkg/tools/validate.mjs', // vendored, not ours
    'lib/features/lefthook.yml',
  ]) {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: f, content: 'x\n' } })
    assert.ok(!denied(r), `${f} should not be treated as harness-protected`)
  }
})

// ── source-check ──────────────────────────────────────────────────────────────
test('source-check blocks an uncited decision site and passes a cited one', () => {
  const uncited = join(proj, 'uncited.ts')
  writeFileSync(uncited, 'export const claims = await supabase.auth.getClaims()\n')
  const r1 = runHook('posttool-source-check.mjs', { tool_input: { file_path: uncited } })
  assert.equal(r1.code, 2, 'uncited decision site must exit 2')

  const cited = join(proj, 'cited.ts')
  writeFileSync(cited, '// SOURCE: supabase docs [corpus: supabase/getclaims]\nexport const claims = await supabase.auth.getClaims()\n')
  const r2 = runHook('posttool-source-check.mjs', { tool_input: { file_path: cited } })
  assert.equal(r2.code, 0, r2.stderr)
})

// ── stop-validate-gate ────────────────────────────────────────────────────────
test('stop gate: green steps exit 0, red steps exit 2, loop guard passes', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    "export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', 'true']]\n",
  )
  const green = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(green.code, 0, green.stderr)

  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    "export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', 'true'], ['boom', 'false']]\n",
  )
  const red = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(red.code, 2, 'red gate must block the turn')
  assert.ok(red.stderr.includes('GREEN GATE'), red.stderr)

  // While red, the gate keeps blocking even on continuation turns — the loop
  // is bounded by the runtime's CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, not by the
  // hook going soft. Only the message changes.
  const looped = runHook('stop-validate-gate.mjs', { stop_hook_active: true })
  assert.equal(looped.code, 2, 'gate must stay red on continuation while failures remain')
  assert.ok(looped.stderr.includes('STILL red'), looped.stderr)

  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    "export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', 'true']]\n",
  )
  const greenLoop = runHook('stop-validate-gate.mjs', { stop_hook_active: true })
  assert.equal(greenLoop.code, 0, 'green gate releases the turn even mid-loop')
})
