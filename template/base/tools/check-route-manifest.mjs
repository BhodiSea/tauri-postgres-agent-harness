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
const CATALOG_FILE = 'apps/desktop/src/i18n/catalog.ts'

// The message keys a route's labelKey may name. `null` when the locale seam is not installed —
// a project that has not adopted i18n keeps the older `label:` form and is not forced onto it.
const catalogKeys = existsSync(CATALOG_FILE)
  ? new Set(
      [...readFileSync(CATALOG_FILE, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]),
    )
  : null
const STATE_KEYS = ['loading', 'empty', 'error']
// A canonical SPA route path: root `/`, or `/`-led lowercase kebab segments with
// no trailing slash, whitespace, query (`?`), or hash (`#`) — the router matches
// on these literally, so a stray space or capital is a silently-dead route.
const PATH_RE = /^\/$|^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/

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
// path -> first entry that claimed it; test-id -> `${entry}.${key}` that claimed
// it. Both closures are GLOBAL across the manifest: a duplicate path routes two
// screens to one URL, and a reused state test id makes the e2e sweeps assert
// against the wrong screen's DOM.
const pathOwners = new Map()
const stateIdOwners = new Map()

// eslint-disable-next-line sonarjs/cognitive-complexity -- ratchet(v0.1.5): 24 today; do not raise
entries.forEach((entry, i) => {
  const id = entry.match(/\bid:\s*['"]([a-z0-9-]+)['"]/)?.[1]
  const name = id ?? `ROUTES[${i}]`
  if (id === undefined) {
    errs.push(`${name}: missing \`id\` (a lowercase [a-z0-9-] string literal)`)
  } else if (ids.has(id)) {
    errs.push(`${name}: duplicate route id`)
  }
  if (id !== undefined) ids.add(id)

  // A route's name is its most visible copy — it is in the nav on every screen and in the
  // command palette. So the manifest carries a message KEY, not the prose: `labelKey:
  // 'route.home'`. A `label: 'Home'` here would be a hardcoded English string in the one file
  // every screen must register in, which is the last place it should be possible.
  //
  // The key must RESOLVE. A manifest that names 'route.hoem' would render the key itself in the
  // nav bar — visible, but only to whoever looked. Checked against the catalog when the locale
  // seam is installed; when it is not (a project that has not adopted i18n), the older `label`
  // form is still accepted, so this gate does not force the seam on anyone.
  const labelKey = entry.match(/\blabelKey:\s*['"]([^'"]+)['"]/)?.[1]
  if (labelKey === undefined) {
    if (entry.match(/\blabel:\s*['"]([^'"]+)['"]/) === null) {
      errs.push(
        `${name}: missing \`labelKey\` (a message key in ${CATALOG_FILE}, e.g. labelKey: 'route.home'). A route's name is copy: it renders in the nav on every screen and in the command palette, so it belongs in the catalog, not in the manifest.`,
      )
    }
  } else if (catalogKeys !== null && !catalogKeys.has(labelKey)) {
    errs.push(
      `${name}: labelKey '${labelKey}' is not a key in ${CATALOG_FILE} — the nav would render the key itself. Add the message, or fix the key.`,
    )
  }

  const pathMatch = entry.match(/\bpath:\s*['"]([^'"]*)['"]/)
  if (pathMatch === null) {
    errs.push(`${name}: missing \`path\` (how the SPA reaches the screen)`)
  } else {
    const path = pathMatch[1]
    if (!PATH_RE.test(path)) {
      errs.push(
        `${name}: path ${JSON.stringify(path)} is not a canonical route path — need a leading slash and lowercase [a-z0-9-] segments (\`/\`, \`/foo\`, \`/foo/bar\`), no trailing slash, whitespace, query, or hash`,
      )
    }
    if (pathOwners.has(path)) {
      errs.push(
        `${name}: duplicate path ${JSON.stringify(path)} — also declared by "${pathOwners.get(path)}"; each screen needs a distinct route path`,
      )
    } else {
      pathOwners.set(path, name)
    }
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
  const seenInEntry = new Map() // test-id -> the key that first used it in THIS entry
  for (const key of STATE_KEYS) {
    const sel = states[1].match(new RegExp(`\\b${key}:\\s*['"]([^'"]*)['"]`))
    if (sel === null || sel[1].trim() === '') {
      errs.push(
        `${name}: states.${key} missing or empty — every screen declares a ${key}-state test id`,
      )
      continue
    }
    const testId = sel[1].trim()
    if (seenInEntry.has(testId)) {
      errs.push(
        `${name}: states.${key} test id ${JSON.stringify(testId)} duplicates states.${seenInEntry.get(testId)} in the same entry — each state needs a distinct test id`,
      )
      continue
    }
    seenInEntry.set(testId, key)
    if (stateIdOwners.has(testId)) {
      errs.push(
        `${name}: states.${key} test id ${JSON.stringify(testId)} is already used by ${stateIdOwners.get(testId)} — state test ids must be globally unique across the manifest`,
      )
    } else {
      stateIdOwners.set(testId, `${name}.${key}`)
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
