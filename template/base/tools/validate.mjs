#!/usr/bin/env node
// Gate runner (`pnpm validate`). Executes VALIDATE_STEPS from tools/harness.config.mjs
// sequentially, prints a per-step summary, and exits non-zero on the first failure — the
// Stop hook and CI both call this, so "done" means the same thing everywhere.
// --min-floor (CI): merge in the hardcoded FLOOR below so the canonical steps always run
//   with their canonical commands even if the config file was edited; config-only extra
//   steps run after the floor.
// --report-all (Stop hook): run EVERY step instead of stopping at the first failure, so
//   an agent sees all reds at once — with ~21 gates and a per-turn block budget, serial
//   one-red-per-turn discovery would exhaust the budget before the chain is green.
// --list: print the resolved steps without running them.
// SOURCE: docs/harness/README.md (the Stop gate defines done; CI floor) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { VALIDATE_STEPS } from './harness.config.mjs'

// The non-negotiable floor: identical copies of the canonical config entries. Keep these
// in lockstep with tools/harness.config.mjs — CI runs --min-floor precisely so a weakened
// config cannot weaken CI. ALL default steps are floored; shape-awareness (e.g. "no Rust
// yet", "no migrations yet") lives INSIDE each gate script as a loud SKIP that fails
// closed in CI when the surface exists — never in floor membership.
// The selftest suite asserts FLOOR ↔ VALIDATE_STEPS lockstep (names and commands).
const FLOOR = [
  ['format', 'pnpm exec biome ci .'],
  ['gate-integrity', 'node tools/check-gate-integrity.mjs'],
  ['rust-fmt', 'node tools/run-rust-gates.mjs fmt'],
  ['types', 'pnpm exec tsc -b'],
  ['lint', 'pnpm exec eslint . --max-warnings 0 --cache'],
  ['provenance', 'node tools/check-sources.mjs'],
  ['tauri-policy', 'node tools/check-tauri-policy.mjs'],
  ['version-sync', 'node tools/check-version-sync.mjs'],
  ['prompts', 'node tools/check-prompts-lock.mjs'],
  ['licenses', 'node tools/check-licenses.mjs'],
  ['schema-rls', 'node tools/check-rls-manifest.mjs'],
  ['migrations', 'node tools/check-migrations.mjs'],
  ['contracts', 'node tools/check-contract-drift.mjs'],
  ['dead-code', 'pnpm exec knip --strict'],
  ['architecture', 'pnpm exec depcruise apps packages --config .dependency-cruiser.cjs'],
  ['build', 'node tools/build-check.mjs'],
  ['rust-check', 'node tools/run-rust-gates.mjs check'],
  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
  ['perf-budget', 'node tools/check-perf-budget.mjs'],
  ['route-manifest', 'node tools/check-route-manifest.mjs'],
  ['e2e', 'node tools/check-e2e.mjs'],
  ['docs-sync', 'node tools/check-docs-sync.mjs'],
]

const flags = new Set(process.argv.slice(2))

function resolveSteps() {
  if (!flags.has('--min-floor')) return VALIDATE_STEPS
  const floorNames = new Set(FLOOR.map(([name]) => name))
  const extras = VALIDATE_STEPS.filter(([name]) => !floorNames.has(name))
  return [...FLOOR, ...extras]
}

const steps = resolveSteps()

if (flags.has('--list')) {
  for (const [name, cmd] of steps) console.log(`${name}  ${cmd}`)
  process.exit(0)
}

const reportAll = flags.has('--report-all')
const results = []
const t0All = performance.now()
for (const [name, cmd] of steps) {
  console.log(`\n=== ${name}: ${cmd}`)
  const t0 = performance.now()
  const ok = spawnSync(cmd, { shell: true, stdio: 'inherit' }).status === 0
  results.push([name, ok, Math.round(performance.now() - t0)])
  if (!ok && !reportAll) break
}

console.log('\nvalidate summary:')
for (const [name, ok, ms] of results) console.log(`  ${ok ? '✓' : '✗'} ${name} (${String(ms)}ms)`)
const notRun = steps.length - results.length
if (notRun > 0) console.log(`  (${String(notRun)} later step(s) not run)`)
console.log(`  total ${String(Math.round(performance.now() - t0All))}ms`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
