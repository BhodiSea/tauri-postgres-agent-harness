#!/usr/bin/env node
// Mutation ratchet (mutation module, nightly lane) — set-based, not score-based.
// A mutation SCORE threshold lets quality silently churn (kill 3 mutants here,
// birth 3 survivors there — same score, worse net). The ratchet compares the
// exact SET of surviving mutants against the committed baseline
// (tools/mutation-baseline.json, write-guard-protected):
//   - a survivor NOT in the baseline  → FAIL (kill it with a test, or a human
//     records it in the baseline with eyes open)
//   - baseline entries no longer surviving → note to tighten (run --write)
//   - --write regenerates the baseline from the current report (human decision)
// Run AFTER `stryker run` with the json reporter; determinism requires the
// stryker lane to run at concurrency 1 (timeout-killed mutants flip status
// under parallel load, and a flaky set compare would be worse than none).
// SOURCE: docs/harness/gates-catalog.md (mutation module) [corpus: harness/doctrine]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fail, ok } from './lib/gate.mjs'

const GATE = 'mutation-ratchet'
const REPORT = 'reports/mutation/mutation.json'
const BASELINE = 'tools/mutation-baseline.json'
const writeMode = process.argv.includes('--write')

if (!existsSync(REPORT)) {
  fail(GATE, `${REPORT} missing — run \`pnpm exec stryker run stryker.config.mjs\` (json reporter) first`)
}
let report
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'))
} catch (e) {
  fail(GATE, `${REPORT} is not valid JSON (${e.message})`)
}

// Canonical survivor identity: file + mutator + span + replacement. Line/column
// keep distinct mutants apart; the replacement disambiguates stacked mutators.
const survivors = []
for (const [file, data] of Object.entries(report.files ?? {})) {
  for (const m of data.mutants ?? []) {
    if (m.status !== 'Survived') continue
    const loc = m.location?.start ?? {}
    survivors.push(
      `${file}:${String(loc.line ?? 0)}:${String(loc.column ?? 0)} ${m.mutatorName} → ${JSON.stringify(m.replacement ?? '')}`,
    )
  }
}
survivors.sort()

if (writeMode) {
  writeFileSync(BASELINE, `${JSON.stringify({ survivors }, null, 2)}\n`)
  console.log(`${GATE}: baseline rewritten with ${String(survivors.length)} survivor(s) — commit it as a reviewed decision`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  fail(
    GATE,
    `${BASELINE} missing — seed it deliberately: node tools/check-mutation-ratchet.mjs --write (then commit; the file is write-guard-protected)`,
  )
}
let baseline
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).survivors ?? [])
} catch (e) {
  fail(GATE, `${BASELINE} is not valid JSON (${e.message}) — the baseline must be reviewable data`)
}

const fresh = survivors.filter((s) => !baseline.has(s))
const killed = [...baseline].filter((s) => !survivors.includes(s))

if (killed.length > 0) {
  console.log(
    `${GATE}: ${String(killed.length)} baseline survivor(s) no longer survive — tighten the ratchet (node tools/check-mutation-ratchet.mjs --write):\n  ${killed.join('\n  ')}`,
  )
}
if (fresh.length > 0) {
  fail(
    GATE,
    `${String(fresh.length)} NEW surviving mutant(s) — write a test that kills each, or (human decision) record it in ${BASELINE}:\n  ${fresh.join('\n  ')}`,
  )
}
ok(GATE, `${String(survivors.length)} survivor(s), all within the committed baseline${killed.length > 0 ? ` (${String(killed.length)} ready to ratchet out)` : ''}`)
