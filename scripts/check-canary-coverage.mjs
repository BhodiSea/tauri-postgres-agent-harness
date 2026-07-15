#!/usr/bin/env node
// Canary-coverage lockstep: every step in the shipped VALIDATE_STEPS ∪
// STOP_HOOK_STEPS must have at least one mechanical red-proof registered in
// tests/canary/injections.json, every proof reference must actually exist, and
// every guard rule id exported by the hooks' pure-data rule tables
// (.claude/hooks/lib/guard-rules.mjs) must have a behavioral canary in
// tests/hooks/hook-contract.test.mjs (per-rule falsifiability closure — an
// unreferenced rule id reds the PR). A NEW gate/rule cannot merge without a
// canary; a DELETED gate cannot leave a stale registry entry.
//   usage: node scripts/check-canary-coverage.mjs [registry-path] [hook-contract-path]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Flags and positionals are separated so `--no-spawn` may appear anywhere without being
// mistaken for the registry path (argv[2]); the two positionals are the optional overrides.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const REGISTRY = resolve(positional[0] ?? join(ROOT, 'tests/canary/injections.json'))
const HOOK_CONTRACT = resolve(positional[1] ?? join(ROOT, 'tests/hooks/hook-contract.test.mjs'))
const errs = []

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const config = await import(
  pathToFileURL(join(ROOT, 'template/base/tools/harness.config.mjs')).href
)
const stepNames = new Set(
  [...config.VALIDATE_STEPS, ...config.STOP_HOOK_STEPS].map(([name]) => name),
)

// 1. Bidirectional closure: steps ↔ registry.
for (const name of stepNames) {
  const proofs = registry.steps?.[name]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(`step '${name}' has NO red-proof in tests/canary/injections.json — a gate that cannot go red is decoration; add a fixture test or selftest canary`)
  }
}
for (const name of Object.keys(registry.steps ?? {})) {
  if (!stepNames.has(name)) {
    errs.push(`registry covers '${name}' but no such step exists in VALIDATE_STEPS ∪ STOP_HOOK_STEPS — stale entry`)
  }
}

// 2. Every proof reference resolves — and, unless --no-spawn, every runnable proof is RUN.
//
// G28: this used to be an existsSync() and nothing more. "The file is there" is a weaker claim
// than "the file is a working proof": a fixture broken by a refactor, or one whose tests were
// all deleted/commented-out, would satisfy existsSync while proving nothing. So each proof is
// now EXECUTED, and must clear two RELIABLE bars:
//   (1) it runs GREEN (exit 0) — catches a proof the gate-under-test's own refactor has broken;
//   (2) it contains at least one REAL test — catches an empty or gutted fixture.
//
// HONEST LIMIT — this does NOT prove the proof drives the gate RED. That is a semantic property
// no generic runner can verify (a test that asserts the gate PASSES also runs green with real
// tests). Writing a proof that actually reds the gate remains the fixture author's job; this
// check guarantees the proof is present, runnable and non-empty, not that it is correct.
//
// Emptiness is detected structurally, NOT by the test count: `node --test` reports "# tests 1"
// for a zero-test file (the file execution itself counts), so a count is useless at the 0/1
// boundary. Instead we look for node's synthetic `ok N - <path>` line, which it emits ONLY when
// a file declared zero tests. And NODE_TEST_* is stripped from the child env: without that, a
// checker spawned from inside `node --test` (the repo test suite) makes its OWN child run as a
// nested subtest, which suppresses that synthetic line — so the emptiness signal would flip
// depending on who invoked the checker. Stripping it makes the child behave identically
// standalone (real CI) and under the suite.
//
// --no-spawn keeps the fast static path for callers that only want the lockstep check (the
// gate-integrity hash surface, the docs-sync lockstep) and for the test suite itself.
const SPAWN = !process.argv.includes('--no-spawn')
const selftest = readFileSync(join(ROOT, '.github/workflows/selftest.yml'), 'utf8')
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')),
)
/** node emits `ok N - <file>.mjs` (a path, not a prose title) ONLY for a zero-test file. */
const ranAsEmpty = (tap) => /^(?:not )?ok \d+ - \S*\.mjs\s*$/m.test(tap)
const ran = new Set()
let spawned = 0

for (const [name, proofs] of Object.entries(registry.steps ?? {})) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'fixture' || proof.kind === 'runner') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`step '${name}': ${proof.kind} proof ${proof.ref} does not exist`)
        continue
      }
      // One spawn per distinct file: six runner-kind steps all point at validate-runner.test.mjs.
      if (!SPAWN || ran.has(proof.ref)) continue
      ran.add(proof.ref)
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', proof.ref], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300_000,
        env: CHILD_ENV,
      })
      spawned += 1
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      if (r.status !== 0) {
        errs.push(
          `step '${name}': red-proof ${proof.ref} FAILS when run — the proof itself is broken (likely by a refactor of the gate it covers), so the gate has no working proof:\n${out.slice(-800)}`,
        )
      } else if (ranAsEmpty(out)) {
        errs.push(
          `step '${name}': red-proof ${proof.ref} runs but declares ZERO tests — an empty or gutted proof is not a proof. Restore its test bodies.`,
        )
      }
    } else if (proof.kind === 'selftest') {
      // A selftest proof names a job in a REAL scaffold on CI (postgres, a built binary, a
      // Windows runner). It cannot be spawned from here; the workflow is the execution.
      if (!selftest.includes(proof.ref)) {
        errs.push(`step '${name}': selftest proof step "${proof.ref}" not found in .github/workflows/selftest.yml`)
      }
    } else {
      errs.push(`step '${name}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 2b. CI-LANE closure. The determinism bar counts a BLOCKING CI LANE as enforcement — that
//     is the whole reason the interaction-latency, memory, integration and mutation lanes
//     may live outside the Stop chain. But a lane that cannot be proven to go red is
//     decoration exactly like a gate that cannot, and until 0.1.6 nothing required a lane to
//     have a red-proof at all: the closure above only ever saw VALIDATE ∪ STOP steps. So
//     every JOB in the shipped quality-gate workflow must carry a proof here — including the
//     explicit, reasoned declaration that a job runs nothing but already-proven steps.
const QG = join(ROOT, 'template/base/github/workflows/quality-gate.yml')
const qgText = readFileSync(QG, 'utf8')
const jobsAt = qgText.indexOf('\njobs:')
const jobIds =
  jobsAt === -1
    ? []
    : [...qgText.slice(jobsAt).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
if (jobIds.length === 0) {
  errs.push(`${QG} exposes no parseable jobs — the CI-lane closure cannot fail open`)
}
const lanes = registry.lanes ?? {}
for (const job of jobIds) {
  const proofs = lanes[job]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(`quality-gate.yml job '${job}' has NO red-proof in tests/canary/injections.json#lanes — a blocking CI lane counts as enforcement, so a lane that cannot go red is decoration. Add a proof, or declare {"kind":"steps"} with a note if the job only runs steps the step registry already proves.`)
  }
}
for (const id of Object.keys(lanes)) {
  if (!jobIds.includes(id)) {
    errs.push(`lanes registry covers '${id}' but quality-gate.yml has no such job — stale entry`)
  }
}
for (const [id, proofs] of Object.entries(lanes)) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'steps') continue // runs only steps the step registry already proves
    if (proof.kind === 'fixture' || proof.kind === 'runner') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`lane '${id}': ${proof.kind} proof ${proof.ref} does not exist`)
      }
    } else if (proof.kind === 'selftest') {
      if (!selftest.includes(proof.ref)) {
        errs.push(`lane '${id}': selftest proof step "${proof.ref}" not found in .github/workflows/selftest.yml`)
      }
    } else {
      errs.push(`lane '${id}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 3. Hook-rule closure: every guard rule id has a behavioral canary. The rule
//    tables are pure data (no side effects) — import them directly and assert
//    each id appears as a quoted string literal in the hook-contract test (where
//    the RULE_CANARIES table keys them). Ids are kebab-case, so they can only
//    appear as quoted object keys — a substring collision is not possible.
const hookContract = readFileSync(HOOK_CONTRACT, 'utf8')
const guardRules = await import(
  pathToFileURL(join(ROOT, 'template/base/.claude/hooks/lib/guard-rules.mjs')).href
)
const ruleTables = ['BASH_RULES', 'WRITE_PROTECTED', 'WRITE_GLOBAL_CHECKS']
const ruleIds = []
for (const table of ruleTables) {
  if (!Array.isArray(guardRules[table]) || guardRules[table].length === 0) {
    errs.push(`guard-rules.mjs is missing/empty export ${table} — the hooks fail closed without it`)
    continue
  }
  for (const rule of guardRules[table]) {
    if (typeof rule?.id !== 'string' || !rule.id) {
      errs.push(`guard-rules.mjs ${table} has a rule without a string id`)
      continue
    }
    ruleIds.push(rule.id)
  }
}
for (const id of ruleIds) {
  if (!hookContract.includes(`'${id}'`) && !hookContract.includes(`"${id}"`)) {
    errs.push(`guard rule id '${id}' has no behavioral canary in tests/hooks/hook-contract.test.mjs — every rule must have a deny/allow case (add a RULE_CANARIES entry)`)
  }
}

// The registry still names one grep-able deny example per guard surface (a
// human-readable spot check that the closure is wired to the real hooks).
for (const [hook, expected] of Object.entries(registry.hookRules ?? {})) {
  for (const example of expected.denyExamples ?? []) {
    if (!hookContract.includes(example)) {
      errs.push(`${hook}: deny example ${JSON.stringify(example)} not found in tests/hooks/hook-contract.test.mjs`)
    }
  }
}

// 3b. Path-scoped checks living INSIDE the hooks (tauri weakenings, append-only
// migrations, DAL wrapper, …) are not in the data tables, so the per-id closure
// above cannot see them. Pin their denyTool( call-site count instead — adding an
// inline deny site forces a conscious registry bump plus a deny test, the speed
// bump the old denySites count provided.
for (const [hook, expected] of Object.entries(registry.hookRules ?? {})) {
  if (typeof expected.denyToolCallSites !== 'number') continue
  const src = readFileSync(join(ROOT, 'template/base/.claude/hooks', hook), 'utf8')
  const count = (src.match(/denyTool\(/g) ?? []).length
  if (count !== expected.denyToolCallSites) {
    errs.push(
      `${hook}: ${count} denyTool( call sites but the registry pins ${expected.denyToolCallSites} — update tests/canary/injections.json hookRules AND add a deny test for the new site`,
    )
  }
}

if (errs.length > 0) {
  console.error(`CANARY COVERAGE: ${errs.length} gap(s):`)
  for (const e of errs) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `CANARY COVERAGE: CLEAN (${stepNames.size} steps each carry a red-proof; ${ruleIds.length} guard rule ids all canaried; ` +
    `${String(spawned)} proof file(s) ${SPAWN ? 'EXECUTED green with real tests (not proof of redness — see G28 note)' : 'existence-checked only (--no-spawn)'})`,
)
