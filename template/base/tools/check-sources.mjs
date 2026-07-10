#!/usr/bin/env node
// Deterministic CI mirror of .claude/hooks/posttool-source-check.mjs — the PostTool hook
// only fires inside Claude Code; this runs the IDENTICAL heuristic over the whole tracked
// tree in `pnpm validate` + CI so unsourced decision sites are caught on every PR, not just
// during an edit. Keep the DECISION regex and the 3-line window in lockstep with the hook.
// SOURCE: docs/harness/README.md (the gate is the enforcement; provenance) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

// Same decision keywords the hook flags: RLS policy SQL, token verification, GUC identity
// discipline, vector index choices, LLM sampling params, tuning constants.
// Mirror exactly — divergence would make the hook and CI disagree.
const DECISION =
  /(FORCE ROW LEVEL SECURITY|CREATE POLICY|pgPolicy|current_setting\(|set_config\(|SET LOCAL|jwtVerify|createRemoteJWKSet|createLocalJWKSet|clockTolerance|USING hnsw|USING ivfflat|vector_cosine_ops|temperature\s*[:=]|top_p\s*[:=]|maxRetries|timeoutMs|rateLimit|backoff)/
const CITED = /(\/\/|--)\s*SOURCE:/

function trackedSourceFiles() {
  const globs = [
    'apps/**/*.ts',
    'apps/**/*.tsx',
    'packages/**/*.ts',
    'packages/**/*.tsx',
    'packages/**/*.sql',
  ]
  // execFileSync, never a shell: sh expands `apps/**/*.ts` before git sees it,
  // and any pattern with a shallow match collapses to just those files — the
  // deep tree silently drops out of the scan (found when Windows cmd, which
  // does not glob, scanned everything and flagged sites POSIX runs missed).
  const out = execFileSync('git', ['ls-files', ...globs], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter(
      (f) =>
        !/\.(test|spec)\.tsx?$/.test(f) &&
        !/\/ipc\/bindings\.ts$/.test(f) &&
        !/\/drizzle\/meta\//.test(f),
    )
}

function flagsFor(file) {
  let src = ''
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = src.split('\n')
  const flagged = []
  lines.forEach((ln, i) => {
    const trimmed = ln.trim()
    // Only flag decision keywords in CODE, not comments that merely mention them.
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('--')
    )
      return
    if (!DECISION.test(ln)) return
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
    if (!CITED.test(window)) flagged.push(`${file}:${i + 1}  ${trimmed.slice(0, 80)}`)
  })
  return flagged
}

const flagged = trackedSourceFiles().flatMap(flagsFor)
if (flagged.length) {
  process.stderr.write(
    `Provenance gate (check:sources): ${String(flagged.length)} decision site(s) lack an inline ` +
      '`// SOURCE:` (`-- SOURCE:` in SQL) citation. Add `SOURCE: <authoritative URL or doc id>` ' +
      'on/above each, then re-run /verify-citations:\n' +
      `${flagged.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write('check:sources — all decision sites carry SOURCE citations (0 flagged)\n')
process.exit(0)
