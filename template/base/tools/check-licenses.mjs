#!/usr/bin/env node
// Gate: licenses — the production dependency tree stays inside the license allowlist,
// so the Stop gate itself refuses a copyleft/unknown-license dependency the moment an
// agent adds one. Exceptions live in tools/license-exceptions.json (reviewable data:
// package name → reason). Rust crates are covered by cargo-deny in the CI rust lane.
// SOURCE: docs/harness/README.md (license gate) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'licenses'

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Zlib',
  'Python-2.0',
  'MPL-2.0', // file-level copyleft: acceptable as a dependency, never vendored
])

if (!existsSync('node_modules')) {
  skipOrFail(GATE, 'node_modules missing — run pnpm install (license tree needs a resolution)')
}

let exceptions = {}
if (existsSync('tools/license-exceptions.json')) {
  exceptions = JSON.parse(readFileSync('tools/license-exceptions.json', 'utf8'))
}

let parsed
try {
  const out = execSync('pnpm licenses list --prod --json', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  parsed = JSON.parse(out)
} catch (e) {
  skipOrFail(GATE, `pnpm licenses failed (${e.message?.slice(0, 120)})`)
}

const errs = []
for (const [license, pkgs] of Object.entries(parsed)) {
  // Compound expressions: accept when ANY OR-branch is allowed.
  const branches = license.replace(/[()]/g, '').split(/\s+OR\s+/i)
  const allowed = branches.some((b) => ALLOWED.has(b.trim()))
  if (allowed) continue
  for (const p of pkgs) {
    if (exceptions[p.name]) continue
    errs.push(`${p.name}@${(p.versions ?? []).join(',')} — license "${license}" not in allowlist`)
  }
}

failures(
  GATE,
  errs,
  'Either replace the dependency, or (human decision) add it to tools/license-exceptions.json with a reason.',
)
ok(GATE, 'production dependency licenses all within the allowlist')
