#!/usr/bin/env node
// PostToolUse / matcher: Edit|Write|MultiEdit — flag non-trivial decision sites that
// lack a // SOURCE: (or -- SOURCE: in SQL) provenance comment. Blocking (exit 2):
// stderr is fed to the model. Only scans files edited this turn; skips tests,
// generated bindings, JSON (cannot carry comments — CSP/installer decisions are
// documented in ADRs instead), and harness tooling.
// SOURCE: docs/harness/README.md (posttool-source-check; provenance)
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.1'

const input = await readHookInput()
const file = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? '')
if (
  !/\.(ts|tsx|sql)$/.test(file) ||
  /\.(test|spec)\.tsx?$/.test(file) ||
  /\/\.claude\/|\/ipc\/bindings\.ts$|\/drizzle\/meta\//.test(file)
) {
  process.exit(0)
}

let src = ''
try {
  src = readFileSync(file, 'utf8')
} catch {
  process.exit(0)
}
const lines = src.split('\n')

// Heuristic decision sites for THIS stack: RLS policy SQL, token verification,
// GUC identity discipline, vector index choices, LLM sampling params, tuning consts.
const DECISION =
  /(FORCE ROW LEVEL SECURITY|CREATE POLICY|pgPolicy|current_setting\(|set_config\(|SET LOCAL|jwtVerify|createRemoteJWKSet|createLocalJWKSet|clockTolerance|USING hnsw|USING ivfflat|vector_cosine_ops|temperature\s*[:=]|top_p\s*[:=]|maxRetries|timeoutMs|rateLimit|backoff)/
const CITED = /(\/\/|--)\s*SOURCE:/
const flagged = []
lines.forEach((ln, i) => {
  // Only flag decision keywords appearing in CODE, not in comments that merely
  // mention them (an explanatory comment about jwtVerify is not a decision site).
  const trimmed = ln.trim()
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('--')
  )
    return
  if (DECISION.test(ln)) {
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
    if (!CITED.test(window)) flagged.push(`${file}:${i + 1}  ${ln.trim().slice(0, 80)}`)
  }
})
if (flagged.length) {
  process.stderr.write(
    `Provenance gate: the following decision sites lack an inline \`// SOURCE:\` (\`-- SOURCE:\` in SQL) citation.\nAdd \`SOURCE: <authoritative URL or doc id>\` on/above each, then re-run /verify-citations:\n${flagged.join('\n')}\n`,
  )
  process.exit(2)
}
process.exit(0)
