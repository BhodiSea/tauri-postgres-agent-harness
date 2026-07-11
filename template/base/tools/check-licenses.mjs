#!/usr/bin/env node
// Gate: licenses — the production dependency tree stays inside the license allowlist,
// so the Stop gate itself refuses a copyleft/unknown-license dependency the moment an
// agent adds one. Exceptions live in tools/license-exceptions.json (reviewable data:
// {"exceptions": [{"package", "reason"}]}). Rust crates are covered by cargo-deny in
// the CI rust lane.
// SOURCE: docs/harness/README.md (license gate) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'licenses'
// Content-addressed local skip: the license verdict is a pure function of the
// lockfile + exception list (declared in lib/stamp-inputs.mjs). CI always re-runs.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

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

// Exceptions — the ONE escape hatch, so its parse fails LOUD, never open.
// Canonical shape: { "comment": string, "exceptions": [{ "package": string, "reason": string }] }
const EXCEPTIONS_FILE = 'tools/license-exceptions.json'
const exceptions = new Set()
if (existsSync(EXCEPTIONS_FILE)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${EXCEPTIONS_FILE} is not valid JSON (${e.message}) — the exception list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.exceptions)) {
    fail(
      GATE,
      `${EXCEPTIONS_FILE} must carry an "exceptions" ARRAY of {package, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed.exceptions) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.package === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${EXCEPTIONS_FILE}: every exception must be {"package": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    exceptions.add(entry.package)
  }
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
    if (exceptions.has(p.name)) continue
    errs.push(`${p.name}@${(p.versions ?? []).join(',')} — license "${license}" not in allowlist`)
  }
}

failures(
  GATE,
  errs,
  'Either replace the dependency, or (human decision) add it to tools/license-exceptions.json with a reason.',
)
recordGreen()
ok(GATE, 'production dependency licenses all within the allowlist')
