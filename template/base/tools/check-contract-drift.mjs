#!/usr/bin/env node
// Gate: contracts — the committed API contract and the project graph cannot drift.
//   1. openapi.json regen-diff: re-emit the OpenAPI document from the live route
//      definitions (apps/server/scripts/emit-openapi.ts, stable-stringified) and diff
//      against the committed apps/server/openapi.json. Requires an install (tsx);
//      skips loudly without one, fails closed in CI.
//   2. tsconfig project-references sync: the solution tsconfig and each package's
//      references must mirror the pnpm workspace dependency graph — three parallel
//      topologies (workspace deps, project refs, knip map) desynchronize into
//      confusing type errors otherwise. Pure static check, no install needed.
// SOURCE: docs/harness/README.md (contracts gate) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'contracts'
const errs = []

// ---- 2. tsconfig references sync (run first: static, always possible) ----
const pkgDirs = []
for (const scope of ['apps', 'packages']) {
  if (!existsSync(scope)) continue
  for (const d of readdirSync(scope)) {
    if (existsSync(join(scope, d, 'package.json'))) pkgDirs.push(join(scope, d))
  }
}
const byName = new Map()
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  byName.set(pkg.name, dir)
}
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((d) => byName.has(d))
    .map((d) => byName.get(d))
  const tsconfigPath = join(dir, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) {
    errs.push(`${dir}: missing tsconfig.json (every workspace package is a TS project)`)
    continue
  }
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
  const refs = new Set((tsconfig.references ?? []).map((r) => relative(dir, join(dir, r.path))))
  for (const dep of wanted) {
    const expected = relative(dir, dep)
    if (!refs.has(expected)) {
      errs.push(
        `${dir}/tsconfig.json: missing project reference to ${dep} (workspace dep ${relative('.', dep)}) — tsc -b cannot order the build without it`,
      )
    }
  }
}
if (existsSync('tsconfig.json')) {
  const solution = JSON.parse(readFileSync('tsconfig.json', 'utf8'))
  const refs = new Set((solution.references ?? []).map((r) => r.path.replace(/^\.\//, '')))
  for (const dir of pkgDirs) {
    if (!refs.has(dir)) errs.push(`tsconfig.json (solution): missing reference to ${dir}`)
  }
}

// ---- 1. openapi regen-diff ----
const EMIT = 'apps/server/scripts/emit-openapi.ts'
const COMMITTED = 'apps/server/openapi.json'
if (existsSync(EMIT)) {
  if (!existsSync('node_modules')) {
    if (errs.length) failures(GATE, errs)
    skipOrFail(GATE, 'node_modules missing — openapi regen-diff needs an install')
  }
  try {
    const regenerated = execSync(`pnpm exec tsx ${EMIT} --stdout`, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const committed = existsSync(COMMITTED) ? readFileSync(COMMITTED, 'utf8') : ''
    if (regenerated.trim() !== committed.trim()) {
      errs.push(
        `${COMMITTED} is stale — routes changed without regenerating the contract. Run: pnpm openapi:emit (then review the diff; consumers depend on it)`,
      )
    }
  } catch (e) {
    errs.push(`openapi emit failed: ${(e.stderr?.toString() ?? e.message).slice(0, 400)}`)
  }
}

failures(GATE, errs)
ok(GATE, 'openapi.json in sync; tsconfig references mirror the workspace graph')
