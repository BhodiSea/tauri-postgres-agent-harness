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
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY = resolve(process.argv[2] ?? join(ROOT, 'tests/canary/injections.json'))
const HOOK_CONTRACT = resolve(process.argv[3] ?? join(ROOT, 'tests/hooks/hook-contract.test.mjs'))
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

// 2. Every proof reference resolves.
const selftest = readFileSync(join(ROOT, '.github/workflows/selftest.yml'), 'utf8')
for (const [name, proofs] of Object.entries(registry.steps ?? {})) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'fixture' || proof.kind === 'runner') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`step '${name}': ${proof.kind} proof ${proof.ref} does not exist`)
      }
    } else if (proof.kind === 'selftest') {
      if (!selftest.includes(proof.ref)) {
        errs.push(`step '${name}': selftest proof step "${proof.ref}" not found in .github/workflows/selftest.yml`)
      }
    } else {
      errs.push(`step '${name}': unknown proof kind ${JSON.stringify(proof.kind)}`)
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
  `CANARY COVERAGE: CLEAN (${stepNames.size} steps all provably red; ${ruleIds.length} guard rule ids all canaried)`,
)
