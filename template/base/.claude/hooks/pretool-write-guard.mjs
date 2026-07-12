#!/usr/bin/env node
// PreToolUse / matcher: Edit|Write|MultiEdit — block invariant-violating file CONTENT
// before it lands. The only reliable place to stop forbidden code being written.
// Mirrors the ESLint/depcruise rules (defense-in-depth) and provides tamper evidence
// (layer 2) for the gate surface itself. Exempts the harness's own tooling (.claude/**)
// and test bodies, which legitimately reference banned patterns.
//
// The protected-path list (WRITE_PROTECTED) and everywhere-content-checks
// (WRITE_GLOBAL_CHECKS) live in ./lib/guard-rules.mjs (pure data, importable by tests);
// this hook keeps the I/O, path-normalization, and path-scoped decision plumbing. Every
// rule id there has a behavioral canary in tests/hooks/hook-contract.test.mjs.
// SOURCE: docs/harness/README.md (pretool-write-guard)
import { existsSync } from 'node:fs'
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.5'

// Dynamic import AFTER hookio installed its fail-closed handlers: a missing, broken, or
// mis-shaped rules module must BLOCK (exit 2) — a guard that cannot load its rules approves
// nothing.
let rules
try {
  rules = await import('./lib/guard-rules.mjs')
} catch (err) {
  process.stderr.write(
    `HOOK CRASHED (guard-rules import) — failing closed, action blocked: ${err?.stack ?? err}\n`,
  )
  process.exit(2)
}
const { WRITE_PROTECTED, WRITE_GLOBAL_CHECKS } = rules
if (
  !Array.isArray(WRITE_PROTECTED) ||
  WRITE_PROTECTED.length === 0 ||
  !Array.isArray(WRITE_GLOBAL_CHECKS) ||
  WRITE_GLOBAL_CHECKS.length === 0
) {
  process.stderr.write(
    'HOOK CRASHED (guard-rules shape) — failing closed, action blocked: WRITE_PROTECTED / WRITE_GLOBAL_CHECKS missing or empty\n',
  )
  process.exit(2)
}

const input = await readHookInput()
const ti = input?.tool_input ?? {}
const path = String(ti.file_path ?? ti.path ?? '')

// Resolve to a path RELATIVE to the project root so the protected patterns can be
// root-anchored (^…) — otherwise a nested node_modules/x/tools/validate.mjs would
// false-match. CLAUDE_PROJECT_DIR is guaranteed for hook subprocesses. Normalize
// to POSIX separators FIRST: on Windows the tool delivers D:\…\tools\validate.mjs,
// and without this every `/`-based PROTECTED pattern silently fails OPEN.
const toPosix = (p) => p.replaceAll('\\', '/')
const projectDir = toPosix(process.env.CLAUDE_PROJECT_DIR ?? '')
const posixPath = toPosix(path)
const rel =
  projectDir && posixPath.startsWith(projectDir)
    ? posixPath.slice(projectDir.length).replace(/^\/+/, '')
    : posixPath.replace(/^\.?\/+/, '')

// Tamper evidence (layer 2): the gate must not be able to rewrite itself. Edits to the
// harness config, the gate runner + the frozen CI floor + every gate script, the RLS
// runner, the lockfiles the gates verify against, the lint/architecture config surface, git
// hooks, and CI workflows require an explicit human-in-the-loop escape hatch. Layer 1 is the
// settings.json deny list. NOTE: tauri.conf.json / capabilities / Cargo.toml are
// deliberately NOT blanket-protected — adding a permission or crate is routine
// vertical-slice work; specific weakenings are content-checked below instead.
// SOURCE: docs/harness/README.md (tamper evidence)
if (process.env.HARNESS_ALLOW_SELF_EDIT !== '1' && WRITE_PROTECTED.some(({ re }) => re.test(rel))) {
  denyTool(
    'PreToolUse',
    'harness-protected file: set HARNESS_ALLOW_SELF_EDIT=1 (human-in-the-loop) to modify the gate itself. SOURCE: docs/harness/README.md (tamper evidence)',
  )
}

// Migrations are APPEND-ONLY: editing an already-committed migration file rewrites
// history that may already be applied to a database. New migration files are fine.
// SOURCE: docs/harness/README.md (append-only migrations)
if (/^packages\/schema\/drizzle\/[^/]+\.sql$/.test(rel) && existsSync(path)) {
  denyTool(
    'PreToolUse',
    'migrations are append-only: never edit an existing migration — add a new one (drizzle-kit generate) that transforms the schema forward.',
  )
}

// Exempt harness tooling and test bodies from the content checks below.
// Deliberately NARROW: only the root-level test trees (the harness's own RLS/
// migration suites), the e2e specs, and colocated *.test.* / *.spec.* FILES.
// A directory merely named "tests" deeper in the app tree (src/dal/tests/…)
// is product code and stays fully content-checked — the old any-segment match
// let real invariant violations ship from such paths.
if (/^\.claude\//.test(rel) || /^(tests?|e2e)\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel)) {
  pass()
}

const text = [
  ti.content,
  ti.new_string,
  ti.new_str,
  ti.replacement,
  ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string ?? '') : []),
]
  .filter((s) => typeof s === 'string')
  .join('\n')
// Positive requirements (X must be present) can only be judged on whole-file
// writes; an Edit fragment legitimately omits distant lines.
const isWholeFile = typeof ti.content === 'string'

// ---- Tauri config surface: content-checked, not blanket-protected ----
if (/(^|\/)tauri\.conf\.json$/.test(rel)) {
  /** @type {[RegExp, string][]} */
  const weakenings = [
    [/"csp"\s*:\s*null/, 'CSP must never be null — the committed CSP is a security invariant.'],
    [/dangerousDisableAssetCspModification|dangerousRemoteDomainIpcAccess|dangerousUseHttpScheme/, 'dangerous* Tauri options are banned.'],
    [/"use"\s*:\s*"brownfield"/, 'the isolation pattern is the default; switching to brownfield needs an ADR + human approval.'],
    [/"webviewInstallMode"\s*:\s*\{[^}]*"type"\s*:\s*"(downloadBootstrapper|skip)"/, 'WebView2 install mode is offlineInstaller (enterprise/offline invariant).'],
  ]
  for (const [re, msg] of weakenings) if (re.test(text)) denyTool('PreToolUse', `tauri.conf.json: ${msg}`)
}
if (/(^|\/)capabilities\/[^/]+\.json$/.test(rel)) {
  /** @type {[RegExp, string][]} */
  const weakenings = [
    [/"remote"\s*:/, 'remote-URL capabilities are banned — IPC is local-window only.'],
    [/shell:allow-|process:allow-/, 'shell/process execution permissions are banned; add a typed #[tauri::command] instead.'],
    [/fs:(allow|scope)[^"]*"[^"]*\*\*/, 'broad filesystem scopes are banned; scope to specific app dirs.'],
  ]
  for (const [re, msg] of weakenings) if (re.test(text)) denyTool('PreToolUse', `capabilities: ${msg}`)
}
if (/(^|\/)src-tauri\/Cargo\.toml$/.test(rel) && isWholeFile && !/unsafe_code\s*=\s*"forbid"/.test(text)) {
  denyTool('PreToolUse', 'src-tauri/Cargo.toml must keep `unsafe_code = "forbid"` in [lints.rust].')
}

// ---- SQL (any location): recursion + GUC discipline ----
if (/\.(sql|ts|tsx|mjs)$/.test(rel) && /WITH\s+RECURSIVE/i.test(text) && !/CYCLE|visited/i.test(text)) {
  denyTool(
    'PreToolUse',
    'WITH RECURSIVE without a CYCLE clause / visited guard can loop forever on graph data — add one. SOURCE: docs/harness/README.md (graph queries)',
  )
}

// Police source code only from here down. Docs/markdown/config legitimately
// mention the banned patterns by name.
if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) pass()

// Everywhere-checks: banned in any source file (WRITE_GLOBAL_CHECKS is pure data).
for (const { re, message } of WRITE_GLOBAL_CHECKS) {
  if (re.test(text)) denyTool('PreToolUse', message)
}

// Desktop-bundle purity: the client never touches server/database modules, and
// Tauri APIs stay wrapped inside src/ipc/** + src/keyboard/**.
if (/^apps\/desktop\//.test(rel)) {
  if (/from\s+['"](postgres|drizzle-orm|pg|@hono\/[^'"]+|pino)['"]/.test(text)) {
    denyTool(
      'PreToolUse',
      'the desktop client must never import server/database modules — talk to the API via typed contracts from @app/schema.',
    )
  }
  const inWrapperDirs = /^apps\/desktop\/src\/(ipc|keyboard)\//.test(rel)
  if (!inWrapperDirs && /from\s+['"]@tauri-apps\//.test(text)) {
    denyTool(
      'PreToolUse',
      'Tauri APIs are wrapped: import them only inside src/ipc/** (bindings) or src/keyboard/** — UI code stays platform-agnostic.',
    )
  }
}

// Positive requirement: DAL modules must run through the request-context wrapper
// (withUserContext = the SET LOCAL RLS identity). Whole-file writes only.
if (/^apps\/server\/src\/dal\/[^/]+\.ts$/.test(rel) && isWholeFile && !/withUserContext/.test(text)) {
  denyTool(
    'PreToolUse',
    'every DAL module must acquire the database through withUserContext(userId, …) — that wrapper IS the authorization boundary (SET LOCAL app.user_id + FORCE RLS).',
  )
}
pass()
