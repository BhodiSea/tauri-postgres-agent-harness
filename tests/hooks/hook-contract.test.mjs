// Contract tests for the shipped Claude Code hooks: pipe hook-event JSON to
// stdin, assert exit codes and deny/block behavior. Hooks are tested from a
// rendered install layout (hooks import ../../tools/harness.config.mjs and
// ./lib/guard-rules.mjs).
//
// The bash/write guard deny/allow cases are TABLE-DRIVEN, keyed by the rule id
// exported from .claude/hooks/lib/guard-rules.mjs (RULE_CANARIES below). A meta-test
// imports that pure-data module and asserts every rule id has at least one canary —
// the per-rule falsifiability closure scripts/check-canary-coverage.mjs greps for.
// Path-scoped inline checks (tauri.conf, capabilities, Cargo, WITH RECURSIVE,
// desktop-import, DAL) have no flat rule id and stay as direct tests.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const GUARD_RULES = new URL('../../template/base/.claude/hooks/lib/guard-rules.mjs', import.meta.url)
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

test('guards fail CLOSED when guard-rules.mjs cannot load (removed module)', () => {
  const broken = mkdtempSync(join(tmpdir(), 'tpah-hooks-broken-'))
  cpSync(join(TEMPLATE, '.claude'), join(broken, '.claude'), { recursive: true })
  // Delete the rule tables the guards depend on: a guard that cannot read its
  // rules must BLOCK (exit 2), never approve.
  rmSync(join(broken, '.claude/hooks/lib/guard-rules.mjs'))
  for (const hook of ['pretool-bash-guard.mjs', 'pretool-write-guard.mjs']) {
    const res = spawnSync('node', [join(broken, '.claude/hooks', hook)], {
      input: JSON.stringify({ tool_input: { command: 'echo hi', file_path: 'x.ts', content: 'x' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: broken },
    })
    assert.equal(res.status, 2, `${hook} must fail closed when guard-rules is missing`)
    assert.match(res.stderr ?? '', /guard-rules|failing closed/i)
  }
})

// ── table-driven guard canaries (keyed by guard-rules rule id) ────────────────
// Every id exported from guard-rules.mjs must appear here (asserted by the meta-test
// below and by scripts/check-canary-coverage.mjs).
const bashDeny = (command) => ({
  hook: 'pretool-bash-guard.mjs',
  input: { tool_name: 'Bash', tool_input: { command } },
  expectDeny: true,
})
const bashAllow = (command, env) => ({
  hook: 'pretool-bash-guard.mjs',
  input: { tool_name: 'Bash', tool_input: { command } },
  expectDeny: false,
  env,
})
const pathDeny = (file_path) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content: 'x\n' } },
  expectDeny: true,
})
const pathAllow = (file_path, env) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content: 'x\n' } },
  expectDeny: false,
  env,
})
const contentDeny = (file_path, content) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content } },
  expectDeny: true,
})

const SELF_EDIT = { HARNESS_ALLOW_SELF_EDIT: '1' }

const RULE_CANARIES = {
  // ── bash-guard ──
  'rm-rf': [
    bashDeny('rm -rf node_modules'),
    // The old single-token regex missed every one of these spellings.
    bashDeny('rm -fr build'),
    bashDeny('rm -Rf build'),
    bashDeny('rm -rF build'),
    bashDeny('rm -r -f build'),
    bashDeny('rm -f -R build'),
    bashDeny('rm --recursive --force build'),
    bashDeny('rm --force --recursive build'),
    bashDeny('rm -v -rf build'),
  ],
  'shell-write-protected': [
    // Shell writes into the enforcement surface bypass the write-guard — denied.
    bashDeny('echo "export const VALIDATE_STEPS = []" > tools/harness.config.mjs'),
    bashDeny('echo deadbeef > .harness/rust-check.ok'),
    bashDeny('cat payload.mjs >> tools/validate.mjs'),
    bashDeny('echo x | tee tools/check-sources.mjs'),
    bashDeny('echo x | tee -a .claude/hooks/stop-validate-gate.mjs'),
    bashDeny('sed -i "s/exit 1/exit 0/" tools/check-migrations.mjs'),
    bashDeny('perl -i -pe "s/deny/pass/" .claude/hooks/pretool-bash-guard.mjs'),
    bashDeny('cp /tmp/evil.mjs tools/validate.mjs'),
    bashDeny('mv patched.yml .github/workflows/quality-gate.yml'),
    bashDeny('echo "-- tweak" >> packages/schema/drizzle/0000_init.sql'),
    bashDeny('echo {} > pnpm-lock.yaml'),
    bashDeny('echo "" > eslint.config.mjs'),
    // Windows spellings — the protected-surface patterns accept both separators.
    bashDeny('echo x > tools\\validate.mjs'),
    bashDeny('echo x | tee .claude\\hooks\\stop-validate-gate.mjs'),
    bashDeny('echo deadbeef > .harness\\build.ok'),
    bashDeny('cp evil.yml .github\\workflows\\quality-gate.yml'),
    // Honors the HARNESS_ALLOW_SELF_EDIT=1 human escape hatch (canary CI uses it).
    bashAllow('echo x > tools/canary-probe.mjs', SELF_EDIT),
  ],
  'git-hookspath-repoint': [
    bashDeny('git config core.hooksPath /tmp/nohooks'),
    bashDeny('git -c core.hooksPath=/dev/null commit -m x'),
  ],
  'dev-auth-access': [
    bashDeny('cat .dev-auth/jwks.json'),
    bashDeny('ls .dev-auth/'),
    bashDeny('cp .dev-auth/token.txt /tmp/t'),
  ],
  'git-force-push': [bashDeny('git push --force origin main')],
  'git-reset-hard': [bashDeny('git reset --hard HEAD~1')],
  'git-commit-no-verify': [bashDeny('git commit --no-verify -m "skip hooks"')],
  'fork-bomb': [bashDeny(':(){ :|:& };:')],
  'read-env-file': [
    bashDeny('cat .env.local'),
    bashDeny('sed -n 1p .env.local'),
    bashDeny('base64 .env'),
  ],
  'source-env-file': [bashDeny('source .env'), bashDeny('. ./.env')],
  'drizzle-kit-push': [bashDeny('pnpm exec drizzle-kit push')],
  'drizzle-kit-drop': [bashDeny('pnpm exec drizzle-kit drop')],
  'knip-fix': [bashDeny('pnpm exec knip --fix')],
  'dependency-update': [bashDeny('pnpm update'), bashDeny('cargo update')],
  'migrator-dsn': [
    bashDeny('psql "$MIGRATOR_DATABASE_URL" -c "select 1"'),
    // Sanctioned contexts pass (the rule's allowWhen predicate).
    bashAllow('MIGRATOR_DATABASE_URL=$X pnpm --filter @app/schema exec drizzle-kit migrate'),
    bashAllow('MIGRATOR_DATABASE_URL=$X node tests/rls/run-rls.mjs'),
  ],
  'destructive-sql': [bashDeny('psql "$DATABASE_URL" -c "DROP TABLE notes"')],
  'tauri-signing-key': [bashDeny('echo TAURI_SIGNING_PRIVATE_KEY=abc >> .env')],
  'minisign-secret-key': [bashDeny('minisign -s /tmp/app.key')],

  // ── write-guard: harness-protected paths ──
  'harness-config': [
    pathDeny('tools/harness.config.mjs'),
    pathAllow('tools/harness.config.mjs', SELF_EDIT),
  ],
  'validate-runner': [pathDeny('tools/validate.mjs')],
  // The frozen CI floor — protected like validate.mjs, escapable under self-edit.
  'validate-floor': [
    pathDeny('tools/validate.floor.json'),
    pathAllow('tools/validate.floor.json', SELF_EDIT),
  ],
  'gate-scripts': [
    pathDeny('tools/check-tauri-policy.mjs'),
    pathDeny('tools/run-rust-gates.mjs'),
    pathDeny('tools/build-check.mjs'),
    pathDeny('tools/check-mutation-ratchet.mjs'),
    pathDeny('tools/perf-baseline.mjs'),
  ],
  // Listed before tools-lib in WRITE_PROTECTED so the citation allowlist carries
  // its own named deny; the SELF_EDIT escape stays human-only, like every rule.
  'citation-domains': [
    pathDeny('tools/lib/citation-domains.mjs'),
    pathAllow('tools/lib/citation-domains.mjs', SELF_EDIT),
  ],
  'tools-lib': [pathDeny('tools/lib/gate.mjs')],
  'tools-mcp': [pathDeny('tools/mcp/corpus-search-server.mjs')],
  'lock-json': [pathDeny('tools/identity.lock.json'), pathDeny('tools/prompts.lock.json')],
  'rls-exempt': [pathDeny('tools/rls-exempt.json')],
  'provenance-overrides': [pathDeny('tools/provenance-overrides.json')],
  'license-exceptions': [pathDeny('tools/license-exceptions.json')],
  'bundle-budget': [pathDeny('tools/bundle-budget.json')],
  // The gzip-ratchet baseline: agent-editing it would re-baseline the agent's
  // own regression; `pnpm perf:baseline` + a reviewed commit is the only path.
  'perf-baseline': [pathDeny('tools/perf-baseline.json')],
  'perf-budget': [pathDeny('tools/perf-budget.json')],
  'styleguide-manifest': [pathDeny('tools/styleguide.manifest.json')],
  'mutation-baseline': [pathDeny('tools/mutation-baseline.json')],
  'route-allowlist': [pathDeny('tools/route-allowlist.json')],
  'rls-runner': [pathDeny('tests/rls/run-rls.mjs')],
  'migration-apply-runner': [pathDeny('tests/migrations/migration-apply.mjs')],
  'lefthook': [pathDeny('lefthook.yml')],
  'github-workflows': [pathDeny('.github/workflows/quality-gate.yml')],
  'eslint-config': [pathDeny('eslint.config.mjs')],
  'biome-config': [pathDeny('biome.jsonc')],
  'knip-config': [pathDeny('knip.json')],
  'dependency-cruiser': [pathDeny('.dependency-cruiser.cjs')],
  'vitest-config': [pathDeny('vitest.config.ts')],
  'playwright-config': [pathDeny('playwright.config.ts')],
  'tsconfig': [pathDeny('tsconfig.json'), pathDeny('tsconfig.base.json')],
  'pnpm-workspace': [pathDeny('pnpm-workspace.yaml')],
  'deny-toml': [pathDeny('deny.toml')],
  'rust-toolchain': [pathDeny('rust-toolchain.toml')],
  'gitleaks-config': [pathDeny('.gitleaks.toml')],
  'claude-settings': [pathDeny('.claude/settings.json')],
  'claude-settings-local': [pathDeny('.claude/settings.local.json')],
  'mcp-json': [pathDeny('.mcp.json')],
  'harness-dir': [pathDeny('.harness/manifest.json')],

  // ── write-guard: everywhere content-checks ──
  'dangerously-set-inner-html': [
    contentDeny('apps/desktop/src/App.tsx', '<div dangerouslySetInnerHTML={{ __html: x }} />\n'),
  ],
  'vite-secret-name': [
    contentDeny('apps/desktop/src/config.ts', 'const k = import.meta.env.VITE_API_SECRET_KEY\n'),
  ],
  'set-config-session-wide': [
    contentDeny('apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', ${id}, false)`\n"),
    // A comma inside the value expression must not hide the session-wide 3rd arg.
    contentDeny('apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', concat(${a}, ${b}), false)`\n"),
    // /i catches SQL-style FALSE.
    contentDeny('apps/server/src/db/context.ts', "await sql`select set_config('app.user_id', ${id}, FALSE)`\n"),
    // A nested "tests"-named product dir is still content-checked (not exempt).
    contentDeny('apps/server/src/dal/tests/helper.ts', "await sql`select set_config('app.user_id', ${id}, false)`\n"),
  ],
  'set-session-app-guc': [
    contentDeny('apps/server/src/db/context.ts', 'await sql`SET SESSION app.user_id = ${id}`\n'),
  ],
  'vitest-workspace-file': [
    contentDeny('vitest.workspace.mts', "import { defineWorkspace } from 'vitest/config'\n"),
  ],
}

for (const [id, cases] of Object.entries(RULE_CANARIES)) {
  cases.forEach((c, i) => {
    test(`rule ${id} [${String(i)}] ${c.expectDeny ? 'denies' : 'allows'} (${c.hook})`, () => {
      const r = runHook(c.hook, c.input, c.env ? { env: c.env } : {})
      assert.equal(denied(r), c.expectDeny, `${id}[${String(i)}]: ${r.stdout} ${r.stderr}`)
    })
  })
}

test('every guard rule id has a behavioral canary (per-rule falsifiability closure)', async () => {
  const { BASH_RULES, WRITE_PROTECTED, WRITE_GLOBAL_CHECKS } = await import(GUARD_RULES.href)
  const ids = [...BASH_RULES, ...WRITE_PROTECTED, ...WRITE_GLOBAL_CHECKS].map((r) => r.id)
  for (const id of ids) {
    assert.ok(
      RULE_CANARIES[id]?.length,
      `guard rule '${id}' has no RULE_CANARIES entry — add a deny/allow case`,
    )
  }
  // No stale canary: a removed rule must not leave a dangling table entry.
  const idSet = new Set(ids)
  for (const key of Object.keys(RULE_CANARIES)) {
    assert.ok(idSet.has(key), `RULE_CANARIES has '${key}' but no guard rule exports that id`)
  }
})

// ── write-guard: allow / no-false-positive contract ───────────────────────────
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

// ── bash-guard: allow contract (must NOT deny) ────────────────────────────────
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

// ── write-guard: path-scoped inline content checks (no flat rule id) ──────────
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

for (const [label, file, content] of [
  ['unguarded WITH RECURSIVE', 'apps/server/src/queries/graph.ts', 'const q = sql`WITH RECURSIVE t AS (SELECT 1)`\n'],
  ['desktop importing drizzle', 'apps/desktop/src/features/notes.ts', "import { eq } from 'drizzle-orm'\n"],
  ['tauri API outside ipc/', 'apps/desktop/src/features/files.ts', "import { open } from '@tauri-apps/plugin-dialog'\n"],
]) {
  test(`write-guard denies (inline check): ${label}`, () => {
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
