// tools/lib/provenance-rules.mjs — the SINGLE source of truth for the provenance
// heuristic. Both enforcement layers import from here — the per-edit PostToolUse hook
// (.claude/hooks/posttool-source-check.mjs) and the tree-wide `provenance` gate
// (tools/check-sources.mjs) — so the decision-site patterns, file scoping, and the
// 3-line SOURCE window can never drift apart the way hand-duplicated regexes did.
// SOURCE: docs/harness/README.md (provenance; one heuristic, two enforcement layers) [corpus: harness/doctrine]
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { toPosix } from './fs-walk.mjs'

// Decision-site keyword groups for THIS stack. Each group's key must be covered by
// at least one corpus entry's `groups` tag in tools/mcp/corpus/index.json — the gate
// asserts that lockstep, so the heuristic cannot grow a new decision class without
// the corpus growing an authority that can ground it.
// Pattern set and order are exactly v0.1.1's hand-maintained DECISION regex (the gate
// and hook carried identical copies; this is their union — nothing weakened).
export const DECISION_GROUPS = [
  {
    key: 'rls-policy',
    description: 'RLS policy SQL — row-security enablement and policy declarations',
    patterns: [/FORCE ROW LEVEL SECURITY/, /CREATE POLICY/, /pgPolicy/],
  },
  {
    key: 'guc-identity',
    description: 'GUC identity discipline — transaction-local RLS identity plumbing',
    patterns: [/current_setting\(/, /set_config\(/, /SET LOCAL/],
  },
  {
    key: 'token-verification',
    description: 'Token verification — jwtVerify, JWKS key resolvers, clock tolerance',
    patterns: [/jwtVerify/, /createRemoteJWKSet/, /createLocalJWKSet/, /clockTolerance/],
  },
  {
    key: 'vector-index',
    description: 'Vector index choices — HNSW vs IVFFlat and operator-class selection',
    patterns: [/USING hnsw/, /USING ivfflat/, /vector_cosine_ops/],
  },
  {
    key: 'llm-sampling',
    description: 'LLM sampling parameters — temperature / top_p constants',
    patterns: [/temperature\s*[:=]/, /top_p\s*[:=]/],
  },
  {
    key: 'tuning-constants',
    description: 'Tuning constants — retry, timeout, rate-limit, backoff values',
    patterns: [/maxRetries/, /timeoutMs/, /rateLimit/, /backoff/],
  },
]

// Combined matcher — the same alternatives, in the same order, as the v0.1.1 regex.
export const DECISION = new RegExp(
  DECISION_GROUPS.flatMap((g) => g.patterns.map((p) => p.source)).join('|'),
)

// A citation comment: `// SOURCE:` (or `-- SOURCE:` in SQL).
export const CITED = /(\/\/|--)\s*SOURCE:/

// A decision line is cited when a SOURCE comment appears on it or within the
// N lines above it.
export const SOURCE_WINDOW_LINES = 3

// What gets scanned at all: code that can carry comments. JSON cannot (CSP and
// installer decisions are documented in ADRs and owned by check-tauri-policy).
export const SCANNABLE_FILE = /\.(ts|tsx|sql)$/

// Excluded everywhere: tests, generated bindings, drizzle metadata.
export const SCAN_EXCLUDES = [/\.(test|spec)\.tsx?$/, /\/ipc\/bindings\.ts$/, /\/drizzle\/meta\//]

// Hook-only exclusion: harness tooling under .claude/ (the gate's globs below never
// reach it, but the hook sees absolute paths for every edited file).
export const HOOK_EXCLUDES = [/\/\.claude\//]

// The tree the gate scans (git pathspecs, expanded by git itself — never a shell).
export const GATE_FILE_GLOBS = [
  'apps/**/*.ts',
  'apps/**/*.tsx',
  'packages/**/*.ts',
  'packages/**/*.tsx',
  'packages/**/*.sql',
]

// Per-edit scope check used by the PostToolUse hook. The hook receives the
// OS-native absolute path from tool_input — normalize to POSIX at this
// boundary so the `/`-based excludes hold on Windows (`apps\desktop\...`).
export function hookScansFile(file) {
  const posix = toPosix(file)
  return (
    SCANNABLE_FILE.test(posix) &&
    !SCAN_EXCLUDES.some((re) => re.test(posix)) &&
    !HOOK_EXCLUDES.some((re) => re.test(posix))
  )
}

// Tree-wide scope check used by the gate on git-listed paths.
export function gateScansFile(file) {
  return !SCAN_EXCLUDES.some((re) => re.test(file))
}

const COMMENT_START = /^(\/\/|\*|\/\*|--)/

// The heuristic itself: flag decision keywords appearing in CODE (not in comments
// that merely mention them) with no SOURCE citation in the window above.
// Returns [{ line, excerpt }] with 1-based line numbers.
export function findUncitedDecisionSites(src) {
  const lines = src.split('\n')
  const flagged = []
  lines.forEach((ln, i) => {
    const trimmed = ln.trim()
    if (COMMENT_START.test(trimmed)) return
    if (!DECISION.test(ln)) return
    const window = lines.slice(Math.max(0, i - SOURCE_WINDOW_LINES), i + 1).join('\n')
    if (!CITED.test(window)) flagged.push({ line: i + 1, excerpt: trimmed.slice(0, 80) })
  })
  return flagged
}

// A corpus reference: `[corpus: <id>]`. The id charset deliberately excludes `<`/`>`
// so documentation placeholders like `[corpus: <id>]` never parse as references.
export const CORPUS_REF = /\[corpus:\s*([A-Za-z0-9][A-Za-z0-9/._-]*)\s*\]/g

// Every SOURCE comment in a file, with its full payload: the text after `SOURCE:`
// plus any continuation comment lines below it (real citations routinely wrap; the
// corpus tail usually lands on the last wrapped line). A new SOURCE comment
// or a non-comment line ends the payload. Returns [{ line, payload }].
export function extractSourceComments(src) {
  const lines = src.split('\n')
  const found = []
  lines.forEach((ln, i) => {
    const m = CITED.exec(ln)
    if (!m) return
    let payload = ln.slice(ln.indexOf('SOURCE:') + 'SOURCE:'.length)
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim()
      if (!COMMENT_START.test(trimmed) || CITED.test(trimmed)) break
      payload += `\n${trimmed}`
    }
    found.push({ line: i + 1, payload })
  })
  return found
}

// A SOURCE payload resolves when it carries at least one of:
//   (a) an https:// URL,
//   (b) a repo-relative path that exists on disk (any token containing '/'),
//   (c) a `[corpus: <id>]` reference (the gate separately resolves the id).
// Presence-only prose ("trust me") is not provenance.
export function payloadResolves(payload, cwd = process.cwd()) {
  if (/https:\/\//.test(payload)) return true
  if (new RegExp(CORPUS_REF.source).test(payload)) return true
  for (const raw of payload.split(/\s+/)) {
    const token = raw.replace(/^[('"`[{<]+/, '').replace(/[)'"`\]}>,.;:]+$/, '')
    if (!token.includes('/') || token.startsWith('/') || /^https?:/i.test(token)) continue
    if (existsSync(resolve(cwd, token))) return true
  }
  return false
}
