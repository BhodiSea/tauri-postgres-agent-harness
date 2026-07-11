// Can-fail proofs for the styleguide gate (template/base/tools/check-styleguide-manifest.mjs).
// Fixture-driven like the schema-rls / route-manifest suites: build a scaffold-shaped
// tree, run the real gate with cwd inside it, assert the exact red/green. The GREEN
// case uses the SHIPPED styles.css + manifest verbatim, so template drift reds here.
// Pins v0.1.3 behavior only — erasure markers, bidirectional token/family closure,
// OKLCH-only colors, the source scan (hex/px/inline-style/erased-palette), the
// per-file allow exemptions, and the single-accent usage budget. (Themes/contrast
// are a later stage and deliberately NOT covered.)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-styleguide-manifest.mjs', import.meta.url),
)
const SHIPPED_STYLES = readFileSync(
  fileURLToPath(new URL('../../template/stack/apps/desktop/src/styles.css', import.meta.url)),
  'utf8',
)
const SHIPPED_MANIFEST = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/styleguide.manifest.json', import.meta.url)),
  'utf8',
)

// sources: extra POSIX-relative files to drop into the tree (the source scan targets
// apps/desktop/src). styles === null omits styles.css (the skip-vs-fail red).
function fixture({ styles = SHIPPED_STYLES, manifest = SHIPPED_MANIFEST, sources = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-styleguide-'))
  mkdirSync(join(dir, 'apps/desktop/src'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (styles !== null) writeFileSync(join(dir, 'apps/desktop/src/styles.css'), styles)
  if (manifest !== null) writeFileSync(join(dir, 'tools/styleguide.manifest.json'), manifest)
  for (const [rel, content] of Object.entries(sources)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
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

// Mutate a parsed copy of the shipped manifest, return it as a JSON string.
function withManifest(mutate) {
  const m = JSON.parse(SHIPPED_MANIFEST)
  mutate(m)
  return JSON.stringify(m, null, 2)
}

test('GREEN: the shipped styles.css + manifest pass in bidirectional lockstep', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
  assert.ok(r.out.includes('accent 0/10'), r.out)
})

test('RED: a @theme --color-* token absent from the manifest reds, naming the token', () => {
  const styles = SHIPPED_STYLES.replace(
    '  --color-accent: oklch(0.8 0.12 200);',
    '  --color-accent: oklch(0.8 0.12 200);\n  --color-foo: oklch(0.5 0.1 200);',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('--color-foo'), r.out)
  assert.ok(r.out.includes('not documented'), r.out)
})

test('RED: a manifest token no longer declared in @theme reds as a stale manifest', () => {
  const manifest = withManifest((m) => m.tokens.push('phantom'))
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('phantom'), r.out)
  assert.ok(r.out.includes('stale manifest'), r.out)
})

test('RED: a non-oklch() color token reds (one color model keeps the contrast table honest)', () => {
  const styles = SHIPPED_STYLES.replace(
    '  --color-canvas: oklch(0.16 0.006 240);',
    '  --color-canvas: rgb(20 20 20);',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('--color-canvas'), r.out)
  assert.ok(r.out.includes('must be oklch'), r.out)
})

test('RED: a missing erasure marker reds (the erased default scale would silently return)', () => {
  const styles = SHIPPED_STYLES.replace('  --shadow-*: initial;\n', '')
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('--shadow-*'), r.out)
  assert.ok(r.out.includes('erasure marker'), r.out)
})

test('RED: family closure violates BOTH directions (@theme-only key, then manifest-only key)', () => {
  // (a) a --radius-* key present in @theme but absent from families.radius.
  const extraKey = SHIPPED_STYLES.replace(
    '  --radius-lg: 0.5rem;',
    '  --radius-lg: 0.5rem;\n  --radius-xl: 1rem;',
  )
  assert.notEqual(extraKey, SHIPPED_STYLES, 'fixture replacement must hit')
  const a = runGate(fixture({ styles: extraKey }))
  assert.equal(a.code, 1, a.out)
  assert.ok(a.out.includes('--radius-xl'), a.out)
  assert.ok(a.out.includes('families.radius'), a.out)

  // (b) a families.radius key the @theme no longer declares.
  const staleManifest = withManifest((m) => m.families.radius.push('xl'))
  const b = runGate(fixture({ manifest: staleManifest }))
  assert.equal(b.code, 1, b.out)
  assert.ok(b.out.includes('families.radius lists "xl"'), b.out)
})

test('RED: a raw hex color in a .tsx reds, naming the offending file', () => {
  const rel = 'apps/desktop/src/features/hex-bad/Swatch.tsx'
  const r = runGate(fixture({ sources: { [rel]: "export const c = '#ff0000'\n" } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(rel), r.out)
  assert.ok(r.out.includes('raw hex color'), r.out)
  assert.ok(r.out.includes('#ff0000'), r.out)
})

test('RED: a raw px length in a source file reds', () => {
  const rel = 'apps/desktop/src/features/px-bad/size.ts'
  const r = runGate(fixture({ sources: { [rel]: "export const w = '4px'\n" } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(rel), r.out)
  assert.ok(r.out.includes('raw length'), r.out)
  assert.ok(r.out.includes('4px'), r.out)
})

test('RED: an inline style={} prop in a .tsx reds', () => {
  const rel = 'apps/desktop/src/features/style-bad/Box.tsx'
  const r = runGate(fixture({ sources: { [rel]: 'export const Box = () => <div style={{}} />\n' } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(rel), r.out)
  assert.ok(r.out.includes('inline style'), r.out)
})

test('RED: a reference to an ERASED default-palette utility reds (it compiles to nothing)', () => {
  const rel = 'apps/desktop/src/features/pal-bad/Btn.tsx'
  const r = runGate(
    fixture({ sources: { [rel]: 'export const Btn = () => <button className="text-red-500" />\n' } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('text-red-500'), r.out)
  assert.ok(r.out.includes('ERASED'), r.out)
})

test('RED: exceeding the accent usage budget reds with the total AND the per-file count', () => {
  const rel = 'apps/desktop/src/features/accent-bad/Loud.tsx'
  const content = `export const Loud = () => <div className="${'bg-accent '.repeat(11)}" />\n`
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('11×'), r.out) // "11×"
  assert.ok(r.out.includes('budget 10'), r.out)
  assert.ok(r.out.includes(`${rel}: 11`), r.out)
})

test('GREEN: .test.tsx files are excluded from the source scan (violations there do not red)', () => {
  const rel = 'apps/desktop/src/features/tested/Widget.test.tsx'
  const content = "export const c = '#ff0000'\nexport const W = () => <div style={{}}>4px</div>\n"
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a per-file allow entry exempts that file from the raw-hex source scan', () => {
  const rel = 'apps/desktop/src/features/vendor/logo.tsx'
  const manifest = withManifest((m) =>
    m.allow.push({ file: rel, reason: 'third-party brand mark, colors fixed by the vendor' }),
  )
  const r = runGate(fixture({ manifest, sources: { [rel]: "export const brand = '#ff8800'\n" } }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a malformed allow entry fails LOUD (the source-scan escape hatch cannot fail open)', () => {
  const manifest = withManifest((m) => {
    m.allow.push({ file: 'apps/desktop/src/features/x/y.tsx' }) // no reason
  })
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('allow entry'), r.out)
})
