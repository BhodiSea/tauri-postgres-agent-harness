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
// passes — AND the v0.1.5 primitive-boundary rule: raw <button|input|select|
// textarea …className=…> outside the controlPrimitives home is red with a FIX
// line naming the primitive; controlAllow (file + reason) is the reviewed escape
// (malformed or stale entries fail closed); a manifest WITHOUT the key
// self-disables with the `update --refresh-seeded` adoption NOTE.
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

test('RED: the AAA (min 7) tier reds an ink that would still pass the old 4.5 floor', () => {
  // v0.1.5: the primary reading pairs (ink/canvas, ink/surface) carry min 7 in
  // the shipped manifest. An ink at the muted lightness computes ~6.2:1 on the
  // light canvas — comfortably past AA 4.5, short of AAA 7 — so this red can
  // ONLY come from the raised per-pair min, proving the tier is live data, not
  // gate code.
  const styles = SHIPPED_STYLES.replace(
    '--color-ink: oklch(0.25 0.01 240)',
    '--color-ink: oklch(0.47 0.01 240)',
  )
  assert.notEqual(styles, SHIPPED_STYLES, 'fixture replacement must hit')
  const r = runGate(fixture({ styles }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "light" contrast ink on'), r.out)
  assert.ok(r.out.includes('(min 7:1)'), r.out)
  // The AA-scoped pairs stay green: no ink-muted/accent failure rides along.
  assert.ok(!r.out.includes('contrast ink-muted'), r.out)
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

// ---- v0.1.5: primitive boundary (conditional on manifest.controlPrimitives) -----
// The scan is .tsx-only, exempts the declared home dir, reads multi-line open
// tags, and controlAllow is its own escape (separate from the px/hex allow).

const RAW_BUTTON =
  'export const Bad = () => <button className="rounded-md bg-surface text-ink">Save</button>\n'

test('RED: a raw <button className=…> outside the components home reds with the FIX line', () => {
  const rel = 'apps/desktop/src/screens/BadScreen.tsx'
  const r = runGate(fixture({ sources: { [rel]: RAW_BUTTON } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(rel), r.out)
  assert.ok(r.out.includes('raw <button'), r.out)
  assert.ok(r.out.includes('FIX: render it through the Button primitive'), r.out)
  assert.ok(r.out.includes('controlAllow'), r.out)
})

test('RED: a MULTI-LINE raw <input> whose className sits on a later line is detected', () => {
  const rel = 'apps/desktop/src/features/form/Field.tsx'
  const content =
    'export const F = () => (\n  <input\n    type="text"\n    aria-label="query"\n    className="rounded-md bg-surface"\n  />\n)\n'
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('raw <input'), r.out)
  assert.ok(r.out.includes('the Input primitive'), r.out)
})

test("GREEN: the declared home dir is the primitives' home — raw controls live there by design", () => {
  const rel = 'apps/desktop/src/components/Custom.tsx'
  const r = runGate(fixture({ sources: { [rel]: RAW_BUTTON } }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a className-less bare <button> is not a primitive-boundary violation', () => {
  const rel = 'apps/desktop/src/screens/Plain.tsx'
  const content =
    'export const P = () => <button type="button" onClick={() => undefined}>Go</button>\n'
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: .ts files are ignored by the primitive-boundary scan (JSX lives in .tsx)', () => {
  const rel = 'apps/desktop/src/lib/snippet.ts'
  const content = 'export const s = \'<button className="rounded-md">x</button>\'\n'
  const r = runGate(fixture({ sources: { [rel]: content } }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a controlAllow entry (file + reason) exempts a LIVE violation, and no NOTE prints', () => {
  const rel = 'apps/desktop/src/features/grid/Cell.tsx'
  const manifest = withManifest((m) =>
    m.controlAllow.push({
      file: rel,
      reason: 'virtualized gridcell buttons: roving-tabindex cells are per-row hot-path controls',
    }),
  )
  const r = runGate(fixture({ manifest, sources: { [rel]: RAW_BUTTON } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes('NOTE'), r.out) // armed manifests run silent, no adoption NOTE
})

test('RED: stale controlAllow entries red — file missing, and file present without a match', () => {
  // (a) the exempted file does not exist.
  const gone = withManifest((m) =>
    m.controlAllow.push({ file: 'apps/desktop/src/features/x/Gone.tsx', reason: 'stale test' }),
  )
  const a = runGate(fixture({ manifest: gone }))
  assert.equal(a.code, 1, a.out)
  assert.ok(a.out.includes('apps/desktop/src/features/x/Gone.tsx'), a.out)
  assert.ok(a.out.includes('does not exist — stale entry'), a.out)

  // (b) the exempted file exists but no longer trips the scan.
  const rel = 'apps/desktop/src/features/x/Clean.tsx'
  const clean = withManifest((m) => m.controlAllow.push({ file: rel, reason: 'stale test' }))
  const b = runGate(
    fixture({
      manifest: clean,
      sources: { [rel]: 'export const C = () => <div className="bg-surface" />\n' },
    }),
  )
  assert.equal(b.code, 1, b.out)
  assert.ok(b.out.includes('matches there anymore'), b.out)
  assert.ok(b.out.includes('stale entry'), b.out)
})

test('RED: a malformed controlAllow entry fails LOUD (the escape hatch cannot fail open)', () => {
  const manifest = withManifest((m) => {
    m.controlAllow.push({ file: 'apps/desktop/src/features/x/y.tsx' }) // no reason
  })
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('controlAllow entry'), r.out)
})

test('RED: a malformed controlPrimitives key fails LOUD (the scan never silently disarms)', () => {
  const manifest = withManifest((m) => {
    m.controlPrimitives = { tags: [], home: 'apps/desktop/src/components' }
  })
  const r = runGate(fixture({ manifest }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('controlPrimitives'), r.out)
})

test('NOTE: a keyless (pre-0.1.5) manifest self-disables the scan, naming key + refresh command', () => {
  const rel = 'apps/desktop/src/screens/BadScreen.tsx'
  const manifest = withManifest((m) => {
    delete m.controlPrimitives
    delete m.controlAllow
  })
  const r = runGate(fixture({ manifest, sources: { [rel]: RAW_BUTTON } }))
  assert.equal(r.code, 0, r.out) // the violation is withheld — the scan is off
  assert.ok(r.out.includes('styleguide: NOTE'), r.out)
  assert.ok(r.out.includes('"controlPrimitives"'), r.out)
  assert.ok(r.out.includes('update --refresh-seeded tools/styleguide.manifest.json'), r.out)
})

// ── status channel (0.1.6) ──────────────────────────────────────────────────────
// The near-monochrome system had no status hue at all, so a failed-write toast rendered
// in the same pixels as "Theme: dark" — the only channel telling a user their data was
// not saved was the prose inside the box. These lock the gate that forbids that.

const ALERT_SURFACE = (className) =>
  `export function Panel() {\n  return <div role="alert" className="${className}">Could not load notes.</div>\n}\n`

test('status: a role=alert surface with NO status token is red, naming the file', () => {
  const rel = 'apps/desktop/src/features/x/Panel.tsx'
  const r = runGate(fixture({ sources: { [rel]: ALERT_SURFACE('rounded border border-edge p-3') } }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /Panel\.tsx: announces status/)
  assert.match(r.out, /role="alert"/)
})

test('status: the same surface painted with a danger token passes', () => {
  const rel = 'apps/desktop/src/features/x/Panel.tsx'
  const r = runGate(
    fixture({ sources: { [rel]: ALERT_SURFACE('rounded border border-danger p-3') } }),
  )
  assert.equal(r.code, 0, r.out)
})

test('status: aria-invalid and role=status are status signals too', () => {
  for (const [signal, source] of [
    ['aria-invalid', 'export const I = () => <input aria-invalid={true} className="border-edge" />\n'],
    ['role="status"', 'export const S = () => <p role="status" className="text-ink">up</p>\n'],
  ]) {
    const r = runGate(fixture({ sources: { 'apps/desktop/src/features/x/S.tsx': source } }))
    assert.equal(r.code, 1, `${signal} must be a status signal: ${r.out}`)
    assert.match(r.out, /announces status/)
  }
})

test('status: a token named only in a COMMENT does not count — the check must not fail open', () => {
  // The bug this exists for: `// border-danger, not border-edge` styles nothing, but a
  // naive whole-file scan reads it as the channel being present and passes.
  const rel = 'apps/desktop/src/features/x/Panel.tsx'
  const commented =
    '// border-danger is the right token here\n' +
    '/* text-success would also match a careless scan */\n' +
    ALERT_SURFACE('rounded border border-edge p-3')
  const r = runGate(fixture({ sources: { [rel]: commented } }))
  assert.equal(r.code, 1, `a commented token must not satisfy the status channel: ${r.out}`)
  assert.match(r.out, /announces status/)
})

test('status: statusSurfaces.allow is the reviewed escape; a STALE entry is red', () => {
  const rel = 'apps/desktop/src/features/x/Panel.tsx'
  const allowed = withManifest((m) => {
    m.statusSurfaces.allow = [{ file: rel, reason: 'legacy surface, scheduled for redesign' }]
  })
  // Live violation + matching allow entry → green.
  const green = runGate(
    fixture({ manifest: allowed, sources: { [rel]: ALERT_SURFACE('border border-edge p-3') } }),
  )
  assert.equal(green.code, 0, green.out)

  // Same allow entry once the file DOES carry the token → the exemption is stale.
  const stale = runGate(
    fixture({ manifest: allowed, sources: { [rel]: ALERT_SURFACE('border border-danger p-3') } }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.match(stale.out, /stale entry/)
})

test('status: a declared status token absent from tokens[] is red (it compiles to nothing)', () => {
  const bogus = withManifest((m) => {
    m.statusSurfaces.tokens = ['danger', 'warning']
  })
  const r = runGate(fixture({ manifest: bogus }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not in tokens\[\]/)
})

test('status: a malformed statusSurfaces key FAILS CLOSED (it can never silently disarm)', () => {
  const broken = withManifest((m) => {
    m.statusSurfaces = { tokens: [], signals: [] }
  })
  const r = runGate(fixture({ manifest: broken }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /cannot silently disarm/)
})

test('status: a pre-0.1.6 manifest without the key self-disables with the adoption NOTE', () => {
  const keyless = withManifest((m) => {
    delete m.statusSurfaces
  })
  const rel = 'apps/desktop/src/features/x/Panel.tsx'
  const r = runGate(
    fixture({ manifest: keyless, sources: { [rel]: ALERT_SURFACE('border border-edge p-3') } }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no "statusSurfaces" key/)
  assert.match(r.out, /refresh-seeded/)
})
