// Can-fail proofs for the route-manifest gate (template/base/tools/check-route-manifest.mjs).
// Fixture-driven like the schema-rls suite: build a scaffold-shaped tree (the GREEN
// case uses the SHIPPED routes.ts + allowlist verbatim, so template drift reds here),
// run the real gate with cwd inside it, assert the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-route-manifest.mjs', import.meta.url),
)
const SHIPPED_ROUTES = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/desktop/src/routes.ts', import.meta.url)),
  'utf8',
)
const SHIPPED_ALLOWLIST = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/route-allowlist.json', import.meta.url)),
  'utf8',
)

// The scaffold's feature directories: notes + matrix are route-referenced, the rest allowlisted.
const SCAFFOLD_FEATURES = ['connection', 'matrix', 'notes', 'palette', 'shortcuts']

function fixture({ routes = SHIPPED_ROUTES, allowlist = SHIPPED_ALLOWLIST, features = SCAFFOLD_FEATURES, catalog = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-routegate-'))
  mkdirSync(join(dir, 'apps/desktop/src/features'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  // The locale seam, when this project has it: the gate checks a route's labelKey RESOLVES.
  if (catalog !== null) {
    mkdirSync(join(dir, 'apps/desktop/src/i18n'), { recursive: true })
    writeFileSync(join(dir, 'apps/desktop/src/i18n/catalog.ts'), catalog)
  }
  if (routes !== null) writeFileSync(join(dir, 'apps/desktop/src/routes.ts'), routes)
  if (allowlist !== null) writeFileSync(join(dir, 'tools/route-allowlist.json'), allowlist)
  for (const name of features) {
    mkdirSync(join(dir, 'apps/desktop/src/features', name), { recursive: true })
    writeFileSync(join(dir, 'apps/desktop/src/features', name, 'index.ts'), 'export {}\n')
  }
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped scaffold shape passes (routes.ts + allowlist + feature dirs verbatim)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('features closure holds'), r.out)
})

test('RED: an unregistered features directory fails NAMING the directory', () => {
  const r = runGate(fixture({ features: [...SCAFFOLD_FEATURES, 'reports'] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('features/reports'), r.out)
  assert.ok(r.out.includes('not referenced by any ROUTES entry'), r.out)
})

test('GREEN: an allowlisted (name + reason) extra directory passes', () => {
  const allowlist = JSON.parse(SHIPPED_ALLOWLIST)
  allowlist.allow.push({ name: 'reports', reason: 'shared table widget, not a screen' })
  const r = runGate(
    fixture({ features: [...SCAFFOLD_FEATURES, 'reports'], allowlist: JSON.stringify(allowlist) }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: malformed allowlist fails LOUD, never open (bad JSON / wrong shape / missing reason)', () => {
  const badJson = runGate(fixture({ allowlist: '{ not json' }))
  assert.equal(badJson.code, 1, badJson.out)
  assert.ok(badJson.out.includes('not valid JSON'), badJson.out)

  const wrongShape = runGate(fixture({ allowlist: JSON.stringify({ dirs: ['connection'] }) }))
  assert.equal(wrongShape.code, 1, wrongShape.out)
  assert.ok(wrongShape.out.includes('ARRAY'), wrongShape.out)

  const noReason = runGate(
    fixture({ allowlist: JSON.stringify({ comment: 'x', allow: [{ name: 'connection' }] }) }),
  )
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('reason'), noReason.out)
})

test('RED: a ROUTES entry missing `states` (or one state key) fails naming the entry and key', () => {
  const noStates = runGate(
    fixture({
      routes: SHIPPED_ROUTES.replace(/,\n {4}states: \{[\s\S]*?\},\n {2}\}/, ',\n  }'),
    }),
  )
  assert.equal(noStates.code, 1, noStates.out)
  assert.ok(noStates.out.includes('home: missing `states`'), noStates.out)

  const noError = runGate(
    fixture({ routes: SHIPPED_ROUTES.replace(/\n\s*error: 'home-error',/, '') }),
  )
  assert.equal(noError.code, 1, noError.out)
  assert.ok(noError.out.includes('states.error missing or empty'), noError.out)
})

test('RED: entries missing id/labelKey/path/features are each named', () => {
  const r = runGate(
    fixture({
      routes:
        "export const ROUTES = [\n  {\n    states: { loading: 'x', empty: 'y', error: 'z' },\n  },\n] as const\n",
      features: SCAFFOLD_FEATURES.filter((f) => f !== 'notes'),
      allowlist: JSON.stringify({
        comment: 'x',
        allow: ['connection', 'notes', 'palette', 'shortcuts']
          .filter((f) => f !== 'notes')
          .map((name) => ({ name, reason: 'widget' })),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing `id`'), r.out)
  assert.ok(r.out.includes('missing `labelKey`'), r.out)
  assert.ok(r.out.includes('missing `path`'), r.out)
  assert.ok(r.out.includes('missing `features`'), r.out)
})

test('RED: an EMPTY ROUTES array is a vacuous manifest', () => {
  const r = runGate(
    fixture({
      routes: 'export const ROUTES = [] as const\n',
      features: SCAFFOLD_FEATURES.filter((f) => f !== 'notes'),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('EMPTY'), r.out)
})

test('RED: stale data both ways — route referencing a missing dir, allowlist naming a missing dir', () => {
  const staleRoute = runGate(fixture({ features: SCAFFOLD_FEATURES.filter((f) => f !== 'notes') }))
  assert.equal(staleRoute.code, 1, staleRoute.out)
  assert.ok(staleRoute.out.includes('features/notes but'), staleRoute.out)

  const staleAllow = runGate(fixture({ features: SCAFFOLD_FEATURES.filter((f) => f !== 'palette') }))
  assert.equal(staleAllow.code, 1, staleAllow.out)
  assert.ok(staleAllow.out.includes('stale allowlist entry'), staleAllow.out)
})

test('skip asymmetry: no desktop surface → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-routegate-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

// ---- v0.1.4: path validity + duplicate path + state-id uniqueness ---------------

test('RED: a malformed path reds naming the id and the offending path', () => {
  for (const bad of ['matrix', '/Matrix ', '/a//b']) {
    const routes = SHIPPED_ROUTES.replace("path: '/matrix'", `path: '${bad}'`)
    assert.notEqual(routes, SHIPPED_ROUTES, `replacement must hit for ${bad}`)
    const r = runGate(fixture({ routes }))
    assert.equal(r.code, 1, `${bad}: ${r.out}`)
    assert.ok(r.out.includes('matrix: path'), `${bad}: ${r.out}`)
    assert.ok(r.out.includes(JSON.stringify(bad)), `${bad}: ${r.out}`)
    assert.ok(r.out.includes('not a canonical route path'), `${bad}: ${r.out}`)
  }
})

test('RED: a duplicate path across entries reds naming both ids', () => {
  const routes = SHIPPED_ROUTES.replace("path: '/matrix'", "path: '/'")
  assert.notEqual(routes, SHIPPED_ROUTES, 'replacement must hit')
  const r = runGate(fixture({ routes }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('matrix: duplicate path'), r.out)
  assert.ok(r.out.includes('also declared by "home"'), r.out)
})

test('RED: a state test id reused across entries reds (global uniqueness) naming both', () => {
  const routes = SHIPPED_ROUTES.replace("loading: 'matrix-loading'", "loading: 'home-loading'")
  assert.notEqual(routes, SHIPPED_ROUTES, 'replacement must hit')
  const r = runGate(fixture({ routes }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('already used by home.loading'), r.out)
  assert.ok(r.out.includes('globally unique'), r.out)
})

test('RED: a state test id duplicated within one entry reds (within-entry distinctness)', () => {
  const routes = SHIPPED_ROUTES.replace("empty: 'home-empty'", "empty: 'home-loading'")
  assert.notEqual(routes, SHIPPED_ROUTES, 'replacement must hit')
  const r = runGate(fixture({ routes }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('home: states.empty test id "home-loading"'), r.out)
  assert.ok(r.out.includes('same entry'), r.out)
})

// ---- v0.1.6 (G22): a route's NAME is copy, so the manifest carries a message key ----

test('RED: a labelKey that is not in the catalog reds — the nav would render the key itself', () => {
  const r = runGate(
    fixture({
      routes:
        "export const ROUTES = [\n  {\n    id: 'home',\n    labelKey: 'route.hoem',\n    path: '/',\n    features: ['notes'],\n    states: { loading: 'x', empty: 'y', error: 'z' },\n  },\n] as const\n",
      features: SCAFFOLD_FEATURES,
      allowlist: JSON.stringify({
        comment: 'x',
        allow: ['connection', 'palette', 'shortcuts', 'matrix'].map((name) => ({ name, reason: 'widget' })),
      }),
      catalog: "export const en = {\n  'route.home': 'Home',\n} as const\n",
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("labelKey 'route.hoem' is not a key"), r.out)
})

test('GREEN: a labelKey that resolves in the catalog passes', () => {
  const r = runGate(
    fixture({
      routes:
        "export const ROUTES = [\n  {\n    id: 'home',\n    labelKey: 'route.home',\n    path: '/',\n    features: ['notes'],\n    states: { loading: 'x', empty: 'y', error: 'z' },\n  },\n] as const\n",
      features: SCAFFOLD_FEATURES,
      allowlist: JSON.stringify({
        comment: 'x',
        allow: ['connection', 'palette', 'shortcuts', 'matrix'].map((name) => ({ name, reason: 'widget' })),
      }),
      catalog: "export const en = {\n  'route.home': 'Home',\n} as const\n",
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a project WITHOUT the locale seam keeps the older `label:` form (not forced onto i18n)', () => {
  const r = runGate(
    fixture({
      routes:
        "export const ROUTES = [\n  {\n    id: 'home',\n    label: 'Home',\n    path: '/',\n    features: ['notes'],\n    states: { loading: 'x', empty: 'y', error: 'z' },\n  },\n] as const\n",
      features: SCAFFOLD_FEATURES,
      allowlist: JSON.stringify({
        comment: 'x',
        allow: ['connection', 'palette', 'shortcuts', 'matrix'].map((name) => ({ name, reason: 'widget' })),
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})
