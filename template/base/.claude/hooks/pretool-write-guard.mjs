#!/usr/bin/env node
// PreToolUse / matcher: Edit|Write|MultiEdit — block invariant-violating file CONTENT
// before it lands. The only reliable place to stop forbidden code being written.
// Mirrors the ESLint/depcruise rules (defense-in-depth) and provides tamper evidence
// (layer 2) for the gate surface itself. Exempts the harness's own tooling (.claude/**)
// and test bodies, which legitimately reference banned patterns.
// SOURCE: docs/harness/README.md (pretool-write-guard)
import { existsSync } from 'node:fs'
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.0'

const input = await readHookInput()
const ti = input?.tool_input ?? {}
const path = String(ti.file_path ?? ti.path ?? '')

// Resolve to a path RELATIVE to the project root so the protected patterns can be
// root-anchored (^…) — otherwise a nested node_modules/x/tools/validate.mjs would
// false-match. CLAUDE_PROJECT_DIR is guaranteed for hook subprocesses.
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? ''
const rel =
  projectDir && path.startsWith(projectDir)
    ? path.slice(projectDir.length).replace(/^\/+/, '')
    : path.replace(/^\.?\/+/, '')

// Tamper evidence (layer 2): the gate must not be able to rewrite itself. Edits to the
// harness config, the gate runner + every gate script, the RLS runner, the lockfiles the
// gates verify against, the lint/architecture config surface, git hooks, and CI workflows
// require an explicit human-in-the-loop escape hatch. Layer 1 is the settings.json deny
// list (hooks + settings + .harness). NOTE: tauri.conf.json / capabilities / Cargo.toml
// are deliberately NOT blanket-protected — adding a permission or crate is routine
// vertical-slice work; specific weakenings are content-checked below instead.
// SOURCE: docs/harness/README.md (tamper evidence)
const PROTECTED = [
  /^tools\/harness\.config\.mjs$/,
  /^tools\/validate\.mjs$/,
  /^tools\/(check-[^/]+|run-rust-gates|build-check)\.mjs$/,
  /^tools\/lib\//, // shared gate helpers — same trust level as the gates themselves
  /^tools\/(identity|prompts)\.lock\.json$/,
  /^tools\/rls-exempt\.json$/, // exempting a table from RLS is a human decision
  /^tests\/rls\/run-rls\.mjs$/, // the RLS runner the Stop hook invokes directly (test bodies stay editable)
  /^tests\/migrations\/migration-apply\.mjs$/,
  /^lefthook\.yml$/,
  /^\.github\/workflows\//,
  // The lint/architecture config surface — weakening any of these weakens the gate.
  /^eslint\.config\.mjs$/,
  /^biome\.jsonc$/,
  /^knip\.json$/,
  /^\.dependency-cruiser\.cjs$/,
  /^tsconfig(\.base)?\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^deny\.toml$/, // cargo-deny policy (licenses + advisories + bans)
  /^rust-toolchain\.toml$/,
  /^\.gitleaks\.toml$/,
  // Permission + MCP surface: never let the agent widen its own grants or add MCP servers.
  /^\.claude\/settings\.json$/,
  /^\.claude\/settings\.local\.json$/,
  /^\.mcp\.json$/,
  /^\.harness\//,
]
if (process.env.HARNESS_ALLOW_SELF_EDIT !== '1' && PROTECTED.some((re) => re.test(rel))) {
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
if (/\/\.claude\/|(^|\/)(tests?|__tests__|e2e)\//.test(path)) pass()

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
  const weakenings = [
    [/"csp"\s*:\s*null/, 'CSP must never be null — the committed CSP is a security invariant.'],
    [/dangerousDisableAssetCspModification|dangerousRemoteDomainIpcAccess|dangerousUseHttpScheme/, 'dangerous* Tauri options are banned.'],
    [/"use"\s*:\s*"brownfield"/, 'the isolation pattern is the default; switching to brownfield needs an ADR + human approval.'],
    [/"webviewInstallMode"\s*:\s*\{[^}]*"type"\s*:\s*"(downloadBootstrapper|skip)"/, 'WebView2 install mode is offlineInstaller (enterprise/offline invariant).'],
  ]
  for (const [re, msg] of weakenings) if (re.test(text)) denyTool('PreToolUse', `tauri.conf.json: ${msg}`)
}
if (/(^|\/)capabilities\/[^/]+\.json$/.test(rel)) {
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

// Everywhere-checks: banned in any source file.
const GLOBAL_CHECKS = [
  [
    /\bdangerouslySetInnerHTML\b/,
    'dangerouslySetInnerHTML is banned (XSS); render sanitized text through approved components.',
  ],
  [
    /VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/,
    'VITE_-prefixed vars are compiled into the client bundle — never put secret-shaped names there.',
  ],
  [
    /set_config\(\s*['"]app\.[a-z_.]+['"]\s*,[^,]+,\s*false\s*\)/,
    'set_config(..., false) sets the GUC session-wide and LEAKS across pooled connections — the third argument must be true (transaction-local). SOURCE: docs/harness/README.md (GUC discipline)',
  ],
  [
    /\bSET\s+SESSION\s+app\.|\bSET\s+app\./i,
    'RLS identity GUCs must be SET LOCAL inside a transaction, never session-wide (pooling leak).',
  ],
  [
    /defineWorkspace|vitest\.workspace/,
    'vitest workspace files are banned — projects are defined in the root vitest.config.ts (single gate surface).',
  ],
]
for (const [re, msg] of GLOBAL_CHECKS) {
  if (re.test(text)) denyTool('PreToolUse', msg)
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
