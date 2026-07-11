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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { parseJsonc } from './lib/jsonc.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'contracts'
// Content-addressed local skip (declared inputs: lib/stamp-inputs.mjs — the
// server sources, committed contract, and workspace topology). CI always re-runs.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])
const errs = []

// tsconfig reference paths are POSIX; join()/relative() yield backslashes on
// Windows — normalize every compared path or the sync check false-fails there.
const posix = (p) => p.split(sep).join('/')

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
  const tsconfig = parseJsonc(readFileSync(tsconfigPath, 'utf8'))
  const refs = new Set(
    (tsconfig.references ?? []).map((r) => posix(relative(dir, join(dir, r.path)))),
  )
  for (const dep of wanted) {
    const expected = posix(relative(dir, dep))
    if (!refs.has(expected)) {
      errs.push(
        `${dir}/tsconfig.json: missing project reference to ${dep} (workspace dep ${relative('.', dep)}) — tsc -b cannot order the build without it`,
      )
    }
  }
}
if (existsSync('tsconfig.json')) {
  const solution = parseJsonc(readFileSync('tsconfig.json', 'utf8'))
  const refs = new Set((solution.references ?? []).map((r) => r.path.replace(/^\.\//, '')))
  for (const dir of pkgDirs) {
    if (!refs.has(posix(dir))) errs.push(`tsconfig.json (solution): missing reference to ${dir}`)
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
    // --silent: under CI=true pnpm prints its auto-install/verify banner to
    // STDOUT, which would pollute the captured JSON and false-fail the diff.
    const regenerated = runCmd(`pnpm --silent exec tsx ${EMIT} --stdout`)
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
recordGreen()
ok(GATE, 'openapi.json in sync; tsconfig references mirror the workspace graph')
