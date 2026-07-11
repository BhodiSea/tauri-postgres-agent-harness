#!/usr/bin/env node
// tools/lib/perf-subject-cli.mjs — the measurement harness the perf-budget gate
// spawns under `pnpm --filter desktop exec tsx`. tsx registers the TS/TSX loader,
// so this plain-node CLI can dynamic-import the desktop's TypeScript perf subject
// (which pulls in react + react-dom/server + the real component graph) and time
// its renderToString. It imports NOTHING beyond node builtins — the subject is
// loaded at runtime via pathToFileURL so the same absolute path works on Windows
// too.
//
// Argv: <absolute subject module> <cells> <runs>. Env: PERF_SUBJECT_EXPECT — the
// anti-vacuity marker the rendered HTML must contain (per-subject `expect` in
// tools/perf-budget.json). It travels via ENVIRONMENT, not argv, because the gate
// spawns this CLI with shell:true (the Windows .cmd shims) and a marker like
// role="gridcell" would be mangled by shell quoting; unset/empty falls back to
// the matrix default role="gridcell", so legacy single-subject budgets behave
// exactly as they did in 0.1.4. On success it prints EXACTLY one JSON line
// `{"samples":[ms,…]}` (runs entries) and exits 0. Any problem — bad argv,
// missing renderSubject export, or a vacuous render (the expected marker absent
// from the HTML, i.e. nothing was actually measured) — exits 1 with a reason on
// stderr. The gate treats a non-zero exit or an unparseable line as a hard FAIL,
// never a silent fallback to a synthetic measurement.
// SOURCE: pathToFileURL for cross-platform dynamic import of an absolute path
// https://nodejs.org/api/url.html#urlpathtofileurlpath-options
import { pathToFileURL } from 'node:url'

const DEFAULT_EXPECT = 'role="gridcell"'

async function main() {
  const [subjectPath, cellsArg, runsArg] = process.argv.slice(2)
  if (subjectPath === undefined || cellsArg === undefined || runsArg === undefined) {
    console.error('usage: perf-subject-cli <absolute-subject-module> <cells> <runs>')
    process.exit(1)
  }
  const cells = Number(cellsArg)
  const runs = Number(runsArg)
  if (!Number.isFinite(cells) || cells <= 0 || !Number.isInteger(runs) || runs <= 0) {
    console.error(`cells and runs must be positive numbers (got ${cellsArg}, ${runsArg})`)
    process.exit(1)
  }
  const envExpect = process.env.PERF_SUBJECT_EXPECT
  const expect = envExpect !== undefined && envExpect !== '' ? envExpect : DEFAULT_EXPECT

  const mod = await import(pathToFileURL(subjectPath).href)
  const renderSubject = mod.renderSubject
  if (typeof renderSubject !== 'function') {
    console.error(`subject ${subjectPath} has no renderSubject(cells) export`)
    process.exit(1)
  }

  // Warmup: JIT + module init noise stays out of the measured runs.
  for (let i = 0; i < 2; i += 1) renderSubject(cells)
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    const html = renderSubject(cells)
    samples.push(performance.now() - start)
    // Anti-vacuity: an empty/degenerate render is a vacuously fast "pass". The
    // expected marker's absence means we measured nothing, so the number would
    // be a lie. The default-marker message stays byte-identical to 0.1.4.
    if (!html.includes(expect)) {
      console.error(
        expect === DEFAULT_EXPECT
          ? 'subject render produced no role="gridcell" cells — measurement is vacuous'
          : `subject render does not contain the expected marker ${expect} — measurement is vacuous`,
      )
      process.exit(1)
    }
  }

  process.stdout.write(`${JSON.stringify({ samples })}\n`)
}

main().catch((error) => {
  console.error(`perf-subject-cli failed: ${error?.stack ?? error?.message ?? error}`)
  process.exit(1)
})
