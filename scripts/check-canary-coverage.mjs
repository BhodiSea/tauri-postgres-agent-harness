#!/usr/bin/env node
// Canary-coverage lockstep: every step in the shipped VALIDATE_STEPS ∪
// STOP_HOOK_STEPS must have at least one mechanical red-proof registered in
// tests/canary/injections.json, every proof reference must actually exist, and
// the hook-guard rule counts must match the registry (adding a rule without a
// deny test breaks the count). A NEW gate cannot merge without a canary; a
// DELETED gate cannot leave a stale registry entry.
//   usage: node scripts/check-canary-coverage.mjs [registry-path]
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY = resolve(process.argv[2] ?? join(ROOT, 'tests/canary/injections.json'))
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

// 3. Hook-rule lockstep: rule counts + grep-able deny examples.
const hookContract = readFileSync(join(ROOT, 'tests/hooks/hook-contract.test.mjs'), 'utf8')
const HOOKS = join(ROOT, 'template/base/.claude/hooks')
const counters = {
  'pretool-bash-guard.mjs': (src, expected) => {
    const actual = (src.match(/Blocked/g) ?? []).length
    if (actual !== expected.blockedMessages) {
      errs.push(`pretool-bash-guard.mjs has ${actual} 'Blocked' rule messages, registry pins ${expected.blockedMessages} — a new rule needs a deny test in tests/hooks/hook-contract.test.mjs AND a registry bump`)
    }
  },
  'pretool-write-guard.mjs': (src, expected) => {
    const denySites = (src.match(/denyTool\(/g) ?? []).length
    const protectedPaths = (src.match(/^ {2}\//gm) ?? []).length
    if (denySites !== expected.denySites) {
      errs.push(`pretool-write-guard.mjs has ${denySites} denyTool sites, registry pins ${expected.denySites} — add a deny test and bump the registry`)
    }
    if (protectedPaths !== expected.protectedPaths) {
      errs.push(`pretool-write-guard.mjs has ${protectedPaths} PROTECTED path patterns, registry pins ${expected.protectedPaths} — add the protected-path test and bump the registry`)
    }
  },
}
for (const [hook, expected] of Object.entries(registry.hookRules ?? {})) {
  const counter = counters[hook]
  if (!counter) {
    errs.push(`registry hookRules covers unknown hook ${hook}`)
    continue
  }
  counter(readFileSync(join(HOOKS, hook), 'utf8'), expected)
  for (const example of expected.denyExamples ?? []) {
    if (!hookContract.includes(example)) {
      errs.push(`${hook}: deny example ${JSON.stringify(example)} not found in tests/hooks/hook-contract.test.mjs`)
    }
  }
}

if (errs.length > 0) {
  console.error(`CANARY COVERAGE: ${errs.length} gap(s):`)
  for (const e of errs) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `CANARY COVERAGE: CLEAN (${stepNames.size} steps all provably red; hook rule counts in lockstep)`,
)
