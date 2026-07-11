// Can-fail proofs for the styleguide gate (template/base/tools/check-styleguide-manifest.mjs).
// Fixture-driven like the schema-rls / route-manifest suites: build a scaffold-shaped
// tree, run the real gate with cwd inside it, assert the exact red/green. The GREEN
// case uses the SHIPPED styles.css + manifest verbatim, so template drift reds here.
// Pins v0.1.3 behavior — erasure markers, bidirectional token/family closure,
// OKLCH-only colors, the source scan (hex/px/inline-style/erased-palette), the
// per-file allow exemptions, the single-accent usage budget — AND the v0.1.4
// additions: theme closure, COMPUTED contrast (oklch->linear sRGB->WCAG luminance
// via tools/lib/oklch.mjs, exercised in-process here too), the arbitrary-value
// scan, and the backward-compat proof that a themes/contrast-less manifest still
// passes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  contrastRatio,
  inSrgbGamut,
  oklchToLinearSrgb,
  relativeLuminance,
} from '../../template/base/tools/lib/oklch.mjs'

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

// ---- v0.1.4: the oklch.mjs math the gate computes contrast with -----------------

test('oklch.mjs: white/black/mid vectors and gamut check', () => {
  const white = oklchToLinearSrgb(1, 0, 0)
  for (const v of [white.r, white.g, white.b]) assert.ok(Math.abs(v - 1) < 1e-4, JSON.stringify(white))
  assert.ok(Math.abs(relativeLuminance(white) - 1) < 1e-4)

  const black = oklchToLinearSrgb(0, 0, 0)
  for (const v of [black.r, black.g, black.b]) assert.ok(Math.abs(v) < 1e-4, JSON.stringify(black))
  assert.ok(Math.abs(relativeLuminance(black)) < 1e-4)

  // white on black is the WCAG ceiling, 21:1.
  const ratio = contrastRatio(relativeLuminance(white), relativeLuminance(black))
  assert.ok(Math.abs(ratio - 21) < 1e-2, `white/black = ${ratio}`)

  // Mid color cross-checked against a trusted converter: sRGB #ff0000 (linear
  // 1,0,0) is oklch(0.6279 0.2577 29.23).
  const red = oklchToLinearSrgb(0.6279, 0.2577, 29.23)
  assert.ok(Math.abs(red.r - 1) < 5e-3 && Math.abs(red.g) < 5e-3 && Math.abs(red.b) < 5e-3, JSON.stringify(red))

  // Gamut: white is displayable; a high-chroma low-lightness hue-200 is not.
  assert.equal(inSrgbGamut(white), true)
  assert.equal(inSrgbGamut(oklchToLinearSrgb(0.475, 0.15, 200)), false)
})

// ---- v0.1.4: theme closure ------------------------------------------------------

test('RED: a theme override missing a token reds (the base value would paint through)', () => {
  const styles = SHIPPED_STYLES.replace('    --color-edge: oklch(0.82 0.008 240);\n', '')
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not override --color-edge'), r.out)
  assert.ok(r.out.includes('paints through'), r.out)
})

test('RED: a non-oklch theme override value reds', () => {
  const styles = SHIPPED_STYLES.replace(
    '    --color-accent: oklch(0.475 0.08 200);',
    '    --color-accent: rgb(0 100 120);',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "light" --color-accent'), r.out)
  assert.ok(r.out.includes('plain oklch()'), r.out)
})

test('RED: a manifest theme whose selector has no override block reds', () => {
  const manifest = withManifest((m) => {
    m.themes.dark = { selector: ":root[data-theme='void']" }
  })
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no `:root[data-theme=\'void\']` override block'), r.out)
})

// ---- v0.1.4: computed contrast --------------------------------------------------

test('RED: a contrast pair below its min reds, printing the computed ratio to 2dp', () => {
  // Lighten the light accent so it fails 4.5:1 on canvas/surface while staying in
  // gamut (so the gate computes a ratio, not "unverifiable").
  const styles = SHIPPED_STYLES.replace(
    '--color-accent: oklch(0.475 0.08 200)',
    '--color-accent: oklch(0.65 0.08 200)',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "light" contrast accent on'), r.out)
  assert.ok(/accent on \w+ = \d+\.\d{2}:1/.test(r.out), r.out) // computed ratio, 2dp
  assert.ok(r.out.includes('(min 4.5:1)'), r.out)
  assert.ok(r.out.includes('FIX:'), r.out)
})

test('RED: an out-of-gamut token reds as contrast unverifiable', () => {
  const styles = SHIPPED_STYLES.replace(
    '--color-accent: oklch(0.475 0.08 200)',
    '--color-accent: oklch(0.475 0.15 200)',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('outside the sRGB gamut'), r.out)
  assert.ok(r.out.includes('unverifiable'), r.out)
})

// ---- v0.1.4: arbitrary-value scan (unconditional) -------------------------------

test('RED: each Tailwind arbitrary-value form reds (utility / property / shorthand)', () => {
  const cases = {
    utility: 'export const A = () => <div className="text-[#abc123]" />\n',
    property: 'export const B = () => <div className="[mask-type:luminance]" />\n',
    shorthand: 'export const C = () => <div className="bg-(--sneaky)" />\n',
  }
  for (const [name, content] of Object.entries(cases)) {
    const rel = `apps/desktop/src/features/arb-${name}/X.tsx`
    const r = runGate(fixture({ sources: { [rel]: content } }))
    assert.equal(r.code, 1, `${name}: ${r.out}`)
    assert.ok(r.out.includes('Tailwind arbitrary value'), `${name}: ${r.out}`)
  }
})

test('GREEN: a tokens-only source file passes the arbitrary-value scan', () => {
  const rel = 'apps/desktop/src/features/clean/Ok.tsx'
  const content = 'export const Ok = () => <div className="bg-surface text-ink rounded-lg p-4" />\n'
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a `[corpus: id]` provenance citation is NOT flagged as an arbitrary property', () => {
  // The property-form regex requires a non-space char right after the colon (the
  // Tailwind grammar), so the mandatory provenance citation form is never a red.
  const rel = 'apps/desktop/src/features/cited/Y.ts'
  const content = '// SOURCE: WAI-ARIA APG grid pattern [corpus: wai-aria/apg-grid]\nexport const Y = 1\n'
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 0, r.out)
})

// ---- v0.1.4: backward-compat ----------------------------------------------------

test('GREEN: a v0.1.3 manifest WITHOUT themes/contrast still passes (self-disabling checks)', () => {
  const manifest = withManifest((m) => {
    delete m.themes
    delete m.contrast
  })
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes('contrast pair'), r.out) // the contrast note is absent
})
