#!/usr/bin/env node
// Gate runner (`pnpm validate`). Executes VALIDATE_STEPS from tools/harness.config.mjs
// sequentially, prints a per-step summary, and exits non-zero on the first failure — the
// Stop hook and CI both call this, so "done" means the same thing everywhere.
// --min-floor (CI): merge in the hardcoded FLOOR below so the canonical steps always run
//   with their canonical commands even if the config file was edited; config-only extra
//   steps run after the floor.
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
  ['rust-fmt', 'node tools/run-rust-gates.mjs fmt'],
  ['types', 'pnpm exec tsc -b'],
  ['lint', 'pnpm exec eslint . --max-warnings 0'],
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

const results = []
for (const [name, cmd] of steps) {
  console.log(`\n=== ${name}: ${cmd}`)
  const ok = spawnSync(cmd, { shell: true, stdio: 'inherit' }).status === 0
  results.push([name, ok])
  if (!ok) break
}

console.log('\nvalidate summary:')
for (const [name, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}`)
const notRun = steps.length - results.length
if (notRun > 0) console.log(`  (${String(notRun)} later step(s) not run)`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
