#!/usr/bin/env node
// Gate runner (`pnpm validate`). Executes VALIDATE_STEPS from tools/harness.config.mjs
// sequentially, prints a per-step summary, and exits non-zero on the first failure — the
// Stop hook and CI both call this, so "done" means the same thing everywhere.
// --min-floor (CI): use the FROZEN snapshot in tools/validate.floor.json as the canonical
//   step list so the canonical steps always run with their canonical commands even if the
//   config file was edited; config-only extra steps run after the floor. The snapshot is a
//   verbatim copy of VALIDATE_STEPS (harness repo: `node scripts/generate-floor.mjs
//   --write`; a selftest asserts equality) — CI trusts THIS file, never the local config,
//   and FAILS CLOSED if it is missing or corrupt (a validate that cannot read its floor
//   must not silently fall back to a weakened config).
// --report-all (Stop hook): run EVERY step instead of stopping at the first failure, so
//   an agent sees all reds at once — with ~21 gates and a per-turn block budget, serial
//   one-red-per-turn discovery would exhaust the budget before the chain is green.
// --list: print the resolved steps without running them.
// SOURCE: docs/harness/README.md (the Stop gate defines done; CI floor) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { VALIDATE_STEPS } from './harness.config.mjs'

const flags = new Set(process.argv.slice(2))

// The non-negotiable floor lives OUTSIDE this runner, in the sibling snapshot
// tools/validate.floor.json — resolved relative to THIS script (validate.mjs runs from the
// scaffold root, but the snapshot travels with the runner). ALL default steps are floored;
// shape-awareness (e.g. "no Rust yet") lives INSIDE each gate script as a loud SKIP that
// fails closed in CI when the surface exists — never in floor membership.
const FLOOR_URL = new URL('./validate.floor.json', import.meta.url)
const FLOOR_HINT =
  'regenerate with `node scripts/generate-floor.mjs --write` (harness repo) or restore it from git'

// Read the frozen floor, FAILING CLOSED on any absence/corruption: a missing or malformed
// snapshot must abort the run, never degrade to the (possibly weakened) local config.
function loadFloor() {
  let raw
  try {
    raw = readFileSync(FLOOR_URL, 'utf8')
  } catch (err) {
    console.error(
      `validate --min-floor: cannot read tools/validate.floor.json (${err.message}) — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(
      `validate --min-floor: tools/validate.floor.json is not valid JSON (${err.message}) — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  const steps = parsed?.steps
  const wellFormed =
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every(
      (s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && typeof s[1] === 'string',
    )
  if (!wellFormed) {
    console.error(
      `validate --min-floor: tools/validate.floor.json has no well-formed \`steps\` array — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  return steps
}

function resolveSteps() {
  if (!flags.has('--min-floor')) return VALIDATE_STEPS
  const floor = loadFloor()
  const floorNames = new Set(floor.map(([name]) => name))
  const extras = VALIDATE_STEPS.filter(([name]) => !floorNames.has(name))
  return [...floor, ...extras]
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
