// Contract tests for the shipped Claude Code hooks: pipe hook-event JSON to
// stdin, assert exit codes and deny/block behavior. Hooks are tested from a
// rendered install layout (hooks import ../../tools/harness.config.mjs).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
let proj

before(() => {
  proj = mkdtempSync(join(tmpdir(), 'tpah-hooks-'))
  cpSync(join(TEMPLATE, '.claude'), join(proj, '.claude'), { recursive: true })
  mkdirSync(join(proj, 'tools'), { recursive: true })
  // posttool-source-check imports the shared heuristic from ../../tools/lib/ —
  // part of the rendered install layout, like harness.config.mjs above.
  cpSync(join(TEMPLATE, 'tools/lib'), join(proj, 'tools/lib'), { recursive: true })
  mkdirSync(join(proj, 'packages/schema/drizzle'), { recursive: true })
  writeFileSync(join(proj, 'packages/schema/drizzle/0000_init.sql'), '-- existing migration\n')
})

function runHook(name, input, { env = {}, cwd = proj } = {}) {
  const res = spawnSync('node', [join(proj, '.claude/hooks', name)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const denied = (r) => r.stdout.includes('"deny"') || r.code === 2

// ── fail-closed I/O contract ─────────────────────────────────────────────────
test('guards fail CLOSED on malformed (non-JSON) stdin', () => {
  for (const hook of ['pretool-bash-guard.mjs', 'pretool-write-guard.mjs']) {
    const r = runHook(hook, 'this is { not json')
    assert.equal(r.code, 2, `${hook} must exit 2 on malformed stdin, got ${r.code}`)
    assert.match(r.stderr, /HOOK CRASHED|failing closed/i)
  }
})

test('guards pass on EMPTY stdin (legitimate no-input events)', () => {
  const r = runHook('pretool-bash-guard.mjs', '')
  assert.equal(r.code, 0)
})

// ── bash-guard ────────────────────────────────────────────────────────────────
for (const cmd of [
  'rm -rf node_modules',
  'git push --force origin main',
  'git reset --hard HEAD~1',
  'git commit --no-verify -m "skip hooks"',
  'cat .env.local',
  'pnpm exec drizzle-kit push',
  'pnpm exec knip --fix',
  'pnpm update',
  'cargo update',
  'psql "$DATABASE_URL" -c "DROP TABLE notes"',
  'echo TAURI_SIGNING_PRIVATE_KEY=abc >> .env',
  'psql "$MIGRATOR_DATABASE_URL" -c "select 1"',
]) {
  test(`bash-guard denies: ${cmd}`, () => {
    assert.ok(denied(runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })), cmd)
  })
}

// rm -rf variant coverage: the old single-token regex missed every one of these.
for (const cmd of [
  'rm -fr build',
  'rm -Rf build',
  'rm -rF build',
  'rm -r -f build',
  'rm -f -R build',
  'rm --recursive --force build',
  'rm --force --recursive build',
  'rm -v -rf build',
]) {
  test(`bash-guard denies rm variant: ${cmd}`, () => {
    assert.ok(denied(runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })), cmd)
  })
}

// Shell writes into the enforcement surface bypass the write-guard — denied.
for (const cmd of [
  'echo "export const VALIDATE_STEPS = []" > tools/harness.config.mjs',
  'echo deadbeef > .harness/rust-check.ok',
  'cat payload.mjs >> tools/validate.mjs',
  'echo x | tee tools/check-sources.mjs',
  'echo x | tee -a .claude/hooks/stop-validate-gate.mjs',
  'sed -i "s/exit 1/exit 0/" tools/check-migrations.mjs',
  'perl -i -pe "s/deny/pass/" .claude/hooks/pretool-bash-guard.mjs',
  'cp /tmp/evil.mjs tools/validate.mjs',
  'mv patched.yml .github/workflows/quality-gate.yml',
  'echo "-- tweak" >> packages/schema/drizzle/0000_init.sql',
  'echo {} > pnpm-lock.yaml',
  'echo "" > eslint.config.mjs',
  // Windows spellings — the protected-surface patterns accept both separators.
  'echo x > tools\\validate.mjs',
  'echo x | tee .claude\\hooks\\stop-validate-gate.mjs',
  'echo deadbeef > .harness\\build.ok',
  'cp evil.yml .github\\workflows\\quality-gate.yml',
]) {
  test(`bash-guard denies shell write: ${cmd}`, () => {
    assert.ok(denied(runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })), cmd)
  })
}

test('bash-guard allows enforcement-surface shell writes under HARNESS_ALLOW_SELF_EDIT=1', () => {
  const r = runHook(
    'pretool-bash-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: 'echo x > tools/canary-probe.mjs' } },
    { env: { HARNESS_ALLOW_SELF_EDIT: '1' } },
  )
  assert.equal(r.code, 0, r.stderr)
  assert.ok(!r.stdout.includes('"deny"'), r.stdout)
})

// hooksPath repoint + secret-surface reads.
for (const cmd of [
  'git config core.hooksPath /tmp/nohooks',
  'git -c core.hooksPath=/dev/null commit -m x',
  'cat .dev-auth/jwks.json',
  'ls .dev-auth/',
  'cp .dev-auth/token.txt /tmp/t',
  'sed -n 1p .env.local',
  'base64 .env',
  'source .env',
  '. ./.env',
]) {
  test(`bash-guard denies: ${cmd}`, () => {
    assert.ok(denied(runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })), cmd)
  })
}

for (const cmd of [
  'pnpm validate',
  'cat .env.example',
  'MIGRATOR_DATABASE_URL=$X pnpm --filter @app/schema exec drizzle-kit migrate',
  'node tests/migrations/migration-apply.mjs # uses MIGRATOR_DATABASE_URL',
  // The RLS runner's own fail-closed hint tells the agent to do exactly this:
  'MIGRATOR_DATABASE_URL=$X node tests/rls/run-rls.mjs',
  'DATABASE_URL=$A MIGRATOR_DATABASE_URL=$B pnpm test:rls',
  'git commit -m "feat: notes"',
  // Reads/derived writes that only LOOK adjacent to the protected surface:
  'node tools/validate.mjs > /tmp/validate.log',
  'cp tools/check-sources.mjs /tmp/inspect.mjs',
  'rm -r build',
  'rm -f stale.log',
  'git config user.email dev@example.com',
  'echo done > /tmp/out.txt',
  'source ./scripts/env.sh',
]) {
  test(`bash-guard passes: ${cmd}`, () => {
    const r = runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes('"deny"'), `${cmd} → ${r.stdout}`)
  })
}

// ── write-guard: tamper evidence ──────────────────────────────────────────────
test('write-guard protects the whole gate + config + permission surface', () => {
  for (const f of [
    'tools/harness.config.mjs',
    'tools/validate.mjs',
    'tools/check-tauri-policy.mjs',
    'tools/run-rust-gates.mjs',
    'tools/build-check.mjs',
    'tools/lib/gate.mjs',
    'tools/mcp/corpus-search-server.mjs',
    'tools/identity.lock.json',
    'tools/prompts.lock.json',
    'tools/rls-exempt.json',
    'tools/license-exceptions.json',
    'tools/bundle-budget.json',
    'tools/perf-budget.json',
    'tools/styleguide.manifest.json',
    'tools/mutation-baseline.json',
    'tools/check-mutation-ratchet.mjs',
    'tools/route-allowlist.json',
    'vitest.config.ts',
    'playwright.config.ts',
    'tests/rls/run-rls.mjs',
    'tests/migrations/migration-apply.mjs',
    'lefthook.yml',
    '.github/workflows/quality-gate.yml',
    'eslint.config.mjs',
    'biome.jsonc',
    'knip.json',
    '.dependency-cruiser.cjs',
    'tsconfig.json',
    'tsconfig.base.json',
    'pnpm-workspace.yaml',
    'deny.toml',
    'rust-toolchain.toml',
    '.gitleaks.toml',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.harness/manifest.json',
  ]) {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: f, content: 'x\n' } })
    assert.ok(denied(r), `${f} must be write-protected`)
  }
})

test('write-guard allows gate edits with HARNESS_ALLOW_SELF_EDIT=1', () => {
  const r = runHook(
    'pretool-write-guard.mjs',
    { tool_input: { file_path: 'tools/harness.config.mjs', content: 'export const VALIDATE_STEPS = []\n' } },
    { env: { HARNESS_ALLOW_SELF_EDIT: '1' } },
  )
  assert.ok(!denied(r), r.stdout)
})

test('write-guard denies Windows-spelled paths (backslashes must not fail open)', () => {
  // Simulates a native-Windows session: OS-native absolute file_path + backslashed
  // CLAUDE_PROJECT_DIR. The guard normalizes both to POSIX before the PROTECTED
  // match — without that, every root-anchored pattern silently fails open.
  const abs = runHook(
    'pretool-write-guard.mjs',
    { tool_input: { file_path: 'D:\\proj\\tools\\validate.mjs', content: 'x\n' } },
    { env: { CLAUDE_PROJECT_DIR: 'D:\\proj' } },
  )
  assert.ok(denied(abs), 'backslashed absolute path must still be write-protected')
  const rel = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'tools\\harness.config.mjs', content: 'x\n' },
  })
  assert.ok(denied(rel), 'backslashed relative path must still be write-protected')
})

test('write-guard does NOT false-positive on ordinary nested project files', () => {
  for (const f of [
    'apps/desktop/src/features/knip.json',
    'node_modules/pkg/tools/validate.mjs',
    'apps/server/src/lefthook.yml',
  ]) {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: f, content: 'const x = 1\n' } })
    assert.ok(!denied(r), `${f} should not be treated as harness-protected`)
  }
})

// ── write-guard: migrations append-only ───────────────────────────────────────
test('write-guard denies edits to an EXISTING migration, allows a NEW one', () => {
  const existing = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'packages/schema/drizzle/0000_init.sql', content: 'ALTER TABLE notes ...\n' },
  })
  assert.ok(denied(existing), 'existing migration must be append-only')
  const fresh = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'packages/schema/drizzle/0001_add_column.sql', content: 'ALTER TABLE notes ADD COLUMN x text;\n' },
  })
  assert.ok(!denied(fresh), fresh.stdout)
})

// ── write-guard: tauri surface content checks ─────────────────────────────────
test('write-guard content-checks tauri.conf.json (not blanket protection)', () => {
  const cases = [
    ['{"app":{"security":{"csp":null}}}', true, 'null CSP'],
    ['{"app":{"security":{"pattern":{"use":"brownfield"}}}}', true, 'brownfield'],
    ['{"bundle":{"windows":{"webviewInstallMode":{"type":"downloadBootstrapper"}}}}', true, 'downloadBootstrapper'],
    ['{"productName":"Renamed App"}', false, 'benign edit'],
  ]
  for (const [content, expectDeny, label] of cases) {
    const r = runHook('pretool-write-guard.mjs', {
      tool_input: { file_path: 'apps/desktop/src-tauri/tauri.conf.json', content },
    })
    assert.equal(denied(r), expectDeny, `${label}: ${r.stdout}`)
  }
})

test('write-guard content-checks capabilities', () => {
  const bad = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/desktop/src-tauri/capabilities/main.json',
      content: '{"permissions":["shell:allow-execute"]}',
    },
  })
  assert.ok(denied(bad), bad.stdout)
  const good = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/desktop/src-tauri/capabilities/main.json',
      content: '{"permissions":["core:default","log:default"]}',
    },
  })
  assert.ok(!denied(good), good.stdout)
})

test('write-guard requires unsafe_code=forbid on whole-file Cargo.toml writes only', () => {
  const stripped = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'apps/desktop/src-tauri/Cargo.toml', content: '[package]\nname = "app"\n' },
  })
  assert.ok(denied(stripped), 'whole-file write without unsafe_code=forbid must be denied')
  const kept = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/desktop/src-tauri/Cargo.toml',
      content: '[package]\nname = "app"\n[lints.rust]\nunsafe_code = "forbid"\n',
    },
  })
  assert.ok(!denied(kept), kept.stdout)
  const fragment = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'apps/desktop/src-tauri/Cargo.toml', new_string: 'serde = "1"' },
  })
  assert.ok(!denied(fragment), 'Edit fragments must not false-deny on absence checks')
})

// ── write-guard: source content invariants ────────────────────────────────────
for (const [label, file, content] of [
  ['session-wide GUC', 'apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', ${id}, false)`\n"],
  ['session-wide GUC hidden by comma in value', 'apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', concat(${a}, ${b}), false)`\n"],
  ['session-wide GUC uppercase FALSE', 'apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', ${id}, FALSE)`\n"],
  ['SET SESSION app.*', 'apps/server/src/db/context.ts', 'await sql`SET SESSION app.user_id = ${id}`\n'],
  ['violation inside a nested tests-named product dir', 'apps/server/src/dal/tests/helper.ts', "await sql`select set_config('app.user_id', ${id}, false)`\n"],
  ['VITE_ secret name', 'apps/desktop/src/config.ts', 'const k = import.meta.env.VITE_API_SECRET_KEY\n'],
  ['dangerouslySetInnerHTML', 'apps/desktop/src/App.tsx', '<div dangerouslySetInnerHTML={{ __html: x }} />\n'],
  ['vitest workspace file', 'vitest.workspace.mts', "import { defineWorkspace } from 'vitest/config'\n"],
  ['unguarded WITH RECURSIVE', 'apps/server/src/queries/graph.ts', 'const q = sql`WITH RECURSIVE t AS (SELECT 1)`\n'],
  ['desktop importing drizzle', 'apps/desktop/src/features/notes.ts', "import { eq } from 'drizzle-orm'\n"],
  ['tauri API outside ipc/', 'apps/desktop/src/features/files.ts', "import { open } from '@tauri-apps/plugin-dialog'\n"],
]) {
  test(`write-guard denies: ${label}`, () => {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: file, content } })
    assert.ok(denied(r), `${label}: ${r.stdout}`)
  })
}

for (const [label, file, content] of [
  ['transaction-local GUC', 'apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', ${id}, true)`\n"],
  ['guarded WITH RECURSIVE', 'apps/server/src/queries/graph.ts', 'const q = sql`WITH RECURSIVE t AS (SELECT 1) CYCLE id SET is_cycle USING path`\n'],
  ['tauri API inside src/ipc', 'apps/desktop/src/ipc/invoke.ts', "import { invoke } from '@tauri-apps/api/core'\n"],
  ['tauri API inside src/keyboard', 'apps/desktop/src/keyboard/global.ts', "import { register } from '@tauri-apps/plugin-global-shortcut'\n"],
]) {
  test(`write-guard passes: ${label}`, () => {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: file, content } })
    assert.ok(!denied(r), `${label}: ${r.stdout}`)
  })
}

test('write-guard requires withUserContext in whole-file DAL writes', () => {
  const bare = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'apps/server/src/dal/notes.ts', content: 'export const list = () => db.select()\n' },
  })
  assert.ok(denied(bare), 'DAL without withUserContext must be denied')
  const wrapped = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/server/src/dal/notes.ts',
      content: "import { withUserContext } from '../db/context'\nexport const list = (u: string) => withUserContext(u, (tx) => tx.select())\n",
    },
  })
  assert.ok(!denied(wrapped), wrapped.stdout)
  const fragment = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'apps/server/src/dal/notes.ts', new_string: 'const limit = 50\n' },
  })
  assert.ok(!denied(fragment), 'Edit fragments must not false-deny the DAL positive check')
})

test('write-guard exempts test bodies from content checks', () => {
  // Root test trees and colocated *.test.* files legitimately reference banned
  // patterns (the RLS suite asserts on set_config false behavior).
  for (const f of [
    'tests/rls/probe.test.ts',
    'e2e/a11y.spec.ts',
    'apps/server/src/dal/notes.test.ts',
  ]) {
    const r = runHook('pretool-write-guard.mjs', {
      tool_input: { file_path: f, content: "await sql`select set_config('app.user_id', ${id}, false)`\n" },
    })
    assert.ok(!denied(r), `${f}: ${r.stdout}`)
  }
})

// ── source-check ──────────────────────────────────────────────────────────────
test('source-check blocks uncited decision sites, passes cited ones (ts + sql)', () => {
  const uncitedTs = join(proj, 'apps/server/src/auth-x.ts')
  mkdirSync(join(proj, 'apps/server/src'), { recursive: true })
  writeFileSync(uncitedTs, 'const claims = await jwtVerify(token, jwks)\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedTs } }).code, 2)

  const citedTs = join(proj, 'apps/server/src/auth-y.ts')
  writeFileSync(citedTs, '// SOURCE: entra docs [corpus: entra/jwt-verify]\nconst claims = await jwtVerify(token, jwks)\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: citedTs } }).code, 0)

  const uncitedSql = join(proj, 'packages/schema/drizzle/9999_x.sql')
  writeFileSync(uncitedSql, 'ALTER TABLE notes FORCE ROW LEVEL SECURITY;\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedSql } }).code, 2)

  const citedSql = join(proj, 'packages/schema/drizzle/9998_y.sql')
  writeFileSync(citedSql, '-- SOURCE: postgres docs [corpus: postgres/rls-force]\nALTER TABLE notes FORCE ROW LEVEL SECURITY;\n')
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: citedSql } }).code, 0)
})

test('source-check skips json, tests, and generated bindings', () => {
  for (const f of ['x.config.json', 'apps/server/src/auth.test.ts', 'apps/desktop/src/ipc/bindings.ts']) {
    const p = join(proj, f)
    mkdirSync(join(proj, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(p, 'jwtVerify(token)\n')
    assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: p } }).code, 0, f)
  }
})

// ── stop-validate-gate ────────────────────────────────────────────────────────
// Portable pass/fail steps (the hook-contracts CI lane also runs on Windows,
// where `true`/`false` are not commands).
const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'

test('stop gate: green steps exit 0, red steps exit 2, loop guard passes', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}']]\n`,
  )
  const green = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(green.code, 0, green.stderr)

  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}'], ['boom', '${FAIL}']]\n`,
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
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}']]\n`,
  )
  const greenLoop = runHook('stop-validate-gate.mjs', { stop_hook_active: true })
  assert.equal(greenLoop.code, 0, 'green gate releases the turn even mid-loop')
})

test('stop gate: steps run under HARNESS_STOP_GATE=1 (fail-closed runners can tell)', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['probe', 'node -e "process.exit(process.env.HARNESS_STOP_GATE === \\'1\\' ? 0 : 1)"']]\n`,
  )
  const r = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(r.code, 0, `HARNESS_STOP_GATE must be set for gate steps: ${r.stderr}`)
})

test('stop gate: a BROKEN config blocks the turn even when the fallback chain would pass', () => {
  writeFileSync(join(proj, 'tools/harness.config.mjs'), 'this is not { valid js\n')
  const r = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(r.code, 2, 'mangled gate config must block the turn')
  assert.ok(r.stderr.includes('gate-config BROKEN'), r.stderr)
  assert.ok(!r.stderr.includes('pnpm validate FAILED'), 'fallback must be direct invocation, not script indirection')
})

test('stop gate: green output surfaces SKIPPED layers instead of staying silent', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['rls', 'node -e "console.log(process.env.X_MSG)"']]\n`,
  )
  const r = runHook('stop-validate-gate.mjs', { stop_hook_active: false }, {
    env: { X_MSG: 'rls-isolation: SKIPPED - database unreachable' },
  })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stderr.includes('skipped layers'), r.stderr)
  assert.ok(r.stderr.includes('SKIPPED'), r.stderr)
})
