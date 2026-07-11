#!/usr/bin/env node
// Gate: route-manifest — every screen the desktop app ships is REGISTERED. The
// canonical manifest (apps/desktop/src/routes.ts, `export const ROUTES`) must be
// non-empty; every entry must carry id / label / path / features plus the three
// canonical state test ids (states.loading/empty/error — e2e/states.spec.ts
// drives each one and the a11y sweeps iterate the same array); and every
// directory under apps/desktop/src/features/ must either be referenced by some
// entry's `features` list or be allowlisted in tools/route-allowlist.json
// (write-guard-protected, human-reviewed, reasons required) — so a screen can
// never ship outside the states/a11y e2e closure. Closure runs BOTH ways:
// manifest entries referencing missing dirs and allowlist entries naming missing
// dirs are stale data and fail too. Static and <100ms: entry-level parsing of
// the ROUTES array literal (brace-depth split + per-field regex on each entry),
// not substring vibes.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'route-manifest'
const ROUTES_FILE = 'apps/desktop/src/routes.ts'
const FEATURES_DIR = 'apps/desktop/src/features'
const ALLOWLIST = 'tools/route-allowlist.json'
const STATE_KEYS = ['loading', 'empty', 'error']

if (!existsSync('apps/desktop/src')) {
  skipOrFail(GATE, 'apps/desktop/src not found (no desktop surface yet)')
}
if (!existsSync(ROUTES_FILE)) {
  skipOrFail(
    GATE,
    `${ROUTES_FILE} not found (no route manifest yet) — export ROUTES entries {id, label, path, features, states:{loading,empty,error}}`,
  )
}

// 1. Allowlist — the ONE escape hatch, so its parse fails LOUD, never open.
//    Canonical shape: { "comment": string, "allow": [{ "name": string, "reason": string }] }
const allow = new Set()
if (existsSync(ALLOWLIST)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOWLIST} is not valid JSON (${e.message}) — the allowlist must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.allow)) {
    fail(
      GATE,
      `${ALLOWLIST} must carry an "allow" ARRAY of {name, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.name === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${ALLOWLIST}: every entry must be {"name": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.name)
  }
}

// 2. Extract the ROUTES array literal (comments stripped first — they legally
//    contain field names and braces).
const src = readFileSync(ROUTES_FILE, 'utf8')
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n')
const arr = code.match(/export const ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/)
if (arr === null) {
  fail(
    GATE,
    `${ROUTES_FILE} must export \`const ROUTES = [ … ] as const satisfies …\` — the canonical route manifest is gone`,
  )
}

// 3. Entry-level split: top-level { … } groups by brace depth. Route data is
//    plain string literals, so braces inside values do not occur by contract.
function splitEntries(body) {
  const entries = []
  let depth = 0
  let start = -1
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        entries.push(body.slice(start, i + 1))
        start = -1
      }
    }
  }
  return entries
}

const entries = splitEntries(arr[1])
if (entries.length === 0) {
  fail(
    GATE,
    `${ROUTES_FILE}: ROUTES is EMPTY — an empty manifest makes every routes-driven e2e suite a vacuous pass; register the app's screens`,
  )
}

const errs = []
const referenced = new Set()
const ids = new Set()

entries.forEach((entry, i) => {
  const id = entry.match(/\bid:\s*['"]([a-z0-9-]+)['"]/)?.[1]
  const name = id ?? `ROUTES[${i}]`
  if (id === undefined) {
    errs.push(`${name}: missing \`id\` (a lowercase [a-z0-9-] string literal)`)
  } else if (ids.has(id)) {
    errs.push(`${name}: duplicate route id`)
  }
  if (id !== undefined) ids.add(id)

  if (entry.match(/\blabel:\s*['"]([^'"]+)['"]/) === null) {
    errs.push(`${name}: missing \`label\` (human-readable string literal)`)
  }
  if (entry.match(/\bpath:\s*['"]([^'"]+)['"]/) === null) {
    errs.push(`${name}: missing \`path\` (how the SPA reaches the screen)`)
  }

  const features = entry.match(/\bfeatures:\s*\[([^\]]*)\]/)
  if (features === null) {
    errs.push(
      `${name}: missing \`features\` (the src/features/<dir> list this screen renders — may be empty)`,
    )
  } else {
    for (const m of features[1].matchAll(/['"]([a-z0-9_-]+)['"]/g)) referenced.add(m[1])
  }

  const states = entry.match(/\bstates:\s*\{([\s\S]*?)\}/)
  if (states === null) {
    errs.push(
      `${name}: missing \`states\` — declare the loading/empty/error test ids (e2e/states.spec.ts drives each one)`,
    )
    return
  }
  for (const key of STATE_KEYS) {
    const sel = states[1].match(new RegExp(`\\b${key}:\\s*['"]([^'"]*)['"]`))
    if (sel === null || sel[1].trim() === '') {
      errs.push(
        `${name}: states.${key} missing or empty — every screen declares a ${key}-state test id`,
      )
    }
  }
})

// 4. Features closure, both directions.
const featureDirs = existsSync(FEATURES_DIR)
  ? readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : []
for (const dir of featureDirs) {
  if (referenced.has(dir) || allow.has(dir)) continue
  errs.push(
    `features/${dir}: not referenced by any ROUTES entry — the surface ships outside the states/a11y e2e closure; add it to a route's \`features\` list, or (human decision) allowlist it with a reason in ${ALLOWLIST}`,
  )
}
for (const name of [...referenced].sort()) {
  if (!featureDirs.includes(name)) {
    errs.push(
      `ROUTES references features/${name} but ${FEATURES_DIR}/${name} does not exist — stale manifest entry`,
    )
  }
}
for (const name of [...allow].sort()) {
  if (!featureDirs.includes(name)) {
    errs.push(
      `${ALLOWLIST} allowlists "${name}" but ${FEATURES_DIR}/${name} does not exist — stale allowlist entry (remove it)`,
    )
  }
}

failures(
  GATE,
  errs,
  `Register the screen in ${ROUTES_FILE} (id/label/path/features/states) or (human decision) allowlist the non-screen feature dir in ${ALLOWLIST} with a reason.`,
)
ok(
  GATE,
  `${entries.length} route(s), ${featureDirs.length} feature dir(s): ids unique, loading/empty/error states declared, features closure holds both ways`,
)
