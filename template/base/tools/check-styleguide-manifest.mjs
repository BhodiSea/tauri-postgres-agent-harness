#!/usr/bin/env node
// Gate: styleguide — the design system is DATA, and this gate keeps it honest.
// Default-on since v0.1.3 (promoted from the gate-styleguide module). Checks over
// the Tailwind v4 CSS-first theme in apps/desktop/src/styles.css and the desktop
// source tree, all in lockstep with tools/styleguide.manifest.json (write-guard-
// protected — evolving the design system is a reviewed human diff):
//   1. erasure markers — every namespace the manifest declares erased keeps its
//      `--<ns>-*: initial` line, so Tailwind's default palette/scales can never
//      silently return.
//   2. token closure — @theme --color-* and manifest.tokens match bidirectionally;
//      same for every family in manifest.families (font/text/radius/shadow/ease).
//   3. OKLCH-only — every color token is an oklch() value. One color model keeps
//      lightness steps perceptually comparable and the WCAG contrast COMPUTABLE.
//   4. theme closure — for every manifest.themes.<name>.selector, the :root
//      override block in styles.css redeclares EXACTLY the manifest tokens
//      (oklch-only, no alpha/var): a missing override token is a base (dark) value
//      silently painting through on the light canvas. (Conditional: v0.1.3
//      manifests without `themes` self-disable this check.)
//   5. computed contrast — for the base @theme AND each theme block, every
//      manifest.contrast {fg,bg,min} pair is CONVERTED oklch->linear sRGB->WCAG
//      luminance and asserted >= min; out-of-gamut tokens fail 'unverifiable'.
//      Contrast is no longer prose in styles.css — it is recomputed here from the
//      token values, so the numbers cannot drift. (Conditional on `contrast`.)
//   6. source scan — no raw hex colors, no raw px lengths, no inline style={}
//      props, no references to erased default-palette utilities, and no Tailwind
//      arbitrary VALUES (text-[..], [prop:val], -(--var)) anywhere in the desktop
//      source (manifest.allow lists file-level exemptions, each with a reason).
//   7. accent budget — the near-monochrome + single-accent design survives on a
//      usage BUDGET: accent-utility occurrences stay <= the documented budget.
// SOURCE: docs/harness/gates-catalog.md (styleguide gate) [corpus: harness/doctrine]
// SOURCE: OKLCH->sRGB reference path for computed contrast [corpus: csswg/oklch-srgb]
// SOURCE: WCAG relative luminance + contrast ratio [corpus: wcag/relative-luminance]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'
import { contrastRatio, inSrgbGamut, oklchToLinearSrgb, relativeLuminance } from './lib/oklch.mjs'

const GATE = 'styleguide'
const STYLES = 'apps/desktop/src/styles.css'
const MANIFEST = 'tools/styleguide.manifest.json'
const SRC_DIR = 'apps/desktop/src'

if (!existsSync(STYLES)) skipOrFail(GATE, `${STYLES} not found (no desktop styles surface yet)`)
if (!existsSync(MANIFEST)) fail(GATE, `${MANIFEST} missing — the harness ships it; restore it`)

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MANIFEST} is not valid JSON (${e.message}) — the design contract must be reviewable data`,
  )
}
const css = readFileSync(STYLES, 'utf8')
const errs = []

// ---- parse the @theme block ---------------------------------------------------
const themeMatch = css.match(/@theme\s*\{([\s\S]*?)\}/)
if (!themeMatch) fail(GATE, `${STYLES} has no @theme block — the token source of truth is gone`)
const theme = themeMatch[1]

// ---- 1: erasure markers -------------------------------------------------------
for (const ns of manifest.erasedNamespaces ?? []) {
  if (!new RegExp(`--${ns}-\\*\\s*:\\s*initial\\s*;`).test(theme)) {
    errs.push(
      `@theme is missing \`--${ns}-*: initial\` — without the erasure marker Tailwind's default ${ns} scale silently returns`,
    )
  }
}

// ---- 2 + 3: color token closure and OKLCH-only ---------------------------------
// A --color-* value map, reused as the base (@theme) palette for computed contrast.
function parseColorTokens(block) {
  const map = new Map()
  for (const m of block.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim())
  return map
}
const declared = parseColorTokens(theme)
if (declared.size === 0) fail(GATE, '@theme declares no --color-* tokens — vacuous theme')

for (const [token, value] of declared) {
  if (!/^oklch\(/.test(value)) {
    errs.push(
      `--color-${token} is "${value}" — all color tokens must be oklch() (one color model keeps the computed contrast in ${STYLES} honest)`,
    )
  }
}

const documented = new Set(manifest.tokens)
for (const token of declared.keys()) {
  if (!documented.has(token)) {
    errs.push(
      `--color-${token} exists in @theme but is not documented in ${MANIFEST} — add it (with intent) or remove it`,
    )
  }
}
for (const token of documented) {
  if (!declared.has(token)) {
    errs.push(
      `${MANIFEST} documents token "${token}" but @theme no longer declares it — stale manifest`,
    )
  }
}

// ---- 2b: family closure (font/text/radius/shadow/ease) -------------------------
// `--text-sm--line-height` belongs to key "sm"; bare namespace values (`--radius:`)
// are implementation detail and exempt from closure.
for (const [family, keys] of Object.entries(manifest.families ?? {})) {
  const inTheme = new Set(
    [...theme.matchAll(new RegExp(`--${family}-([a-z0-9-]+?)(?:--line-height)?\\s*:`, 'g'))]
      .map((m) => m[1])
      .filter((k) => k !== '*'),
  )
  const inManifest = new Set(keys)
  for (const k of inTheme) {
    if (!inManifest.has(k)) {
      errs.push(`--${family}-${k} exists in @theme but not in ${MANIFEST} families.${family}`)
    }
  }
  for (const k of inManifest) {
    if (!inTheme.has(k)) {
      errs.push(
        `${MANIFEST} families.${family} lists "${k}" but @theme no longer declares --${family}-${k}`,
      )
    }
  }
}

// ---- 4: theme closure (conditional on manifest.themes) -------------------------
// A theme is a :root override block that MUST redeclare exactly the token set — a
// missing override token means the base (dark) value paints through on the light
// canvas. Its `selector` in the manifest may quote with ' where the CSS uses " (or
// vice versa), so quote chars match interchangeably. Values must be plain oklch()
// literals (no alpha, no var()) so the contrast pass below can convert them.
const themeBlocks = new Map() // name -> { selector, tokens: Map }
for (const [name, spec] of Object.entries(manifest.themes ?? {})) {
  if (spec === null || typeof spec !== 'object' || typeof spec.selector !== 'string') {
    fail(
      GATE,
      `${MANIFEST} themes.${name} must be { "selector": string } — got ${JSON.stringify(spec)}`,
    )
  }
  const selector = spec.selector
  // Escape regex metachars in the selector, then let ' and " match either quote.
  const selRe = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['"]/g, `['"]`)}\\s*\\{([\\s\\S]*?)\\}`,
  )
  const block = css.match(selRe)
  if (block === null) {
    errs.push(
      `theme "${name}": no \`${selector}\` override block in ${STYLES} — the manifest declares this theme but styles.css has no override`,
    )
    continue
  }
  const overrides = parseColorTokens(block[1])
  themeBlocks.set(name, { selector, tokens: overrides })
  const overrideNames = new Set(overrides.keys())
  for (const t of documented) {
    if (!overrideNames.has(t)) {
      errs.push(
        `theme "${name}" (${selector}) does not override --color-${t} — the base value paints through; a theme must redeclare all ${documented.size} color tokens`,
      )
    }
  }
  for (const t of overrideNames) {
    if (!documented.has(t)) {
      errs.push(
        `theme "${name}" (${selector}) overrides --color-${t}, which is not a documented token — add it to ${MANIFEST} tokens or drop the override`,
      )
    }
  }
  for (const [t, value] of overrides) {
    if (!/^oklch\(/.test(value) || value.includes('var(') || value.includes('/')) {
      errs.push(
        `theme "${name}" --color-${t} is "${value}" — theme overrides must be plain oklch() literals (no alpha, no var()) so contrast is computable`,
      )
    }
  }
}

// ---- 5: computed contrast (conditional on manifest.contrast) -------------------
// Parse `oklch(L C H)` (optional % on L), convert to linear sRGB, and assert the
// WCAG ratio for each declared pair, in the base @theme AND every theme block. An
// out-of-gamut token is 'unverifiable': the browser gamut-maps it, so its painted
// contrast is not the computed one.
function parseOklch(value) {
  const m = value.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/)
  if (m === null) return null
  const l = m[1].endsWith('%') ? Number.parseFloat(m[1]) / 100 : Number.parseFloat(m[1])
  return { l, c: Number.parseFloat(m[2]), h: Number.parseFloat(m[3]) }
}

function checkContrast(themeLabel, tokenValues) {
  for (const pair of manifest.contrast) {
    if (
      pair === null ||
      typeof pair !== 'object' ||
      typeof pair.fg !== 'string' ||
      typeof pair.bg !== 'string' ||
      typeof pair.min !== 'number' ||
      pair.min <= 0
    ) {
      fail(
        GATE,
        `${MANIFEST} contrast entries must be { "fg": string, "bg": string, "min": positive number } — got ${JSON.stringify(pair)}`,
      )
    }
    const { fg, bg, min } = pair
    const fgVal = tokenValues.get(fg)
    const bgVal = tokenValues.get(bg)
    if (fgVal === undefined || bgVal === undefined) {
      errs.push(
        `${themeLabel} contrast ${fg}/${bg}: token "${fgVal === undefined ? fg : bg}" not declared in this theme`,
      )
      continue
    }
    const fgc = parseOklch(fgVal)
    const bgc = parseOklch(bgVal)
    if (fgc === null || bgc === null) {
      errs.push(`${themeLabel} contrast ${fg}/${bg}: could not parse an oklch(L C H) value`)
      continue
    }
    const fgRgb = oklchToLinearSrgb(fgc.l, fgc.c, fgc.h)
    const bgRgb = oklchToLinearSrgb(bgc.l, bgc.c, bgc.h)
    if (!inSrgbGamut(fgRgb) || !inSrgbGamut(bgRgb)) {
      const bad = inSrgbGamut(fgRgb) ? bg : fg
      errs.push(
        `${themeLabel} contrast ${fg}/${bg}: --color-${bad} is outside the sRGB gamut — contrast unverifiable (the browser gamut-maps it; reduce its chroma until it displays as authored)`,
      )
      continue
    }
    const ratio = contrastRatio(relativeLuminance(fgRgb), relativeLuminance(bgRgb))
    if (ratio < min) {
      errs.push(
        `${themeLabel} contrast ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (min ${min}:1) — FIX: adjust --color-${fg} or --color-${bg} in ${STYLES} until the computed ratio clears ${min}:1`,
      )
    }
  }
}

if (Array.isArray(manifest.contrast)) {
  checkContrast('base (@theme)', declared)
  for (const [name, { tokens }] of themeBlocks) checkContrast(`theme "${name}"`, tokens)
}

// ---- 6: source scan — escapes from the token system ----------------------------
// Exemptions are file-level, each with a reviewed reason; malformed = loud fail.
const allowFiles = new Set()
for (const entry of manifest.allow ?? []) {
  const okShape =
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.file === 'string' &&
    typeof entry.reason === 'string' &&
    entry.reason.trim().length > 0
  if (!okShape) {
    fail(
      GATE,
      `${MANIFEST}: every allow entry must be {"file": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
    )
  }
  allowFiles.add(entry.file)
}

// Tailwind's default palette names: after erasure these utilities compile to
// NOTHING, so a reference is a silent no-op — worse than off-brand.
const PALETTE = new RegExp(
  '\\b(?:text|bg|border|ring|outline|fill|stroke|decoration|divide|from|via|to|caret|accent|shadow)-' +
    '(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}\\b',
  'g',
)

// Tailwind arbitrary VALUES — the escape the palette-name scan misses. Three
// forms, each an off-token color/length smuggled inline instead of extending the
// vocabulary:
//   utility:  text-[#abc], w-[13px], grid-cols-[1fr_2fr]
//   property: [mask-type:luminance], [--x:0]  (bracket-property class)
//   v4 short: bg-(--my-var), text-(--brand)   (shorthand for arbitrary var())
// The property form requires a NON-whitespace char right after the colon: that is
// exactly the Tailwind grammar (arbitrary values encode spaces as `_`, never a
// literal space), and it precisely excludes prose bracket-colon forms — above all
// the MANDATORY `[corpus: <id>]` provenance citations that live in nearly every
// source comment. This is grammar precision, not a weakened check.
const ARBITRARY = [
  /\b[a-z][a-z0-9:/_-]*-\[[^\]\s]+\]/g,
  /(["'\s])\[[a-z-]+:[^\]\s][^\]]*\]/g,
  /\b[a-z][a-z0-9:/_-]*-\(--[a-z0-9-]+\)/g,
]

// Shared walker (lib/fs-walk.mjs): POSIX-relative output, so allow-list
// comparison holds on Windows without per-file normalization.
const files = walkFiles(SRC_DIR, {
  filter: (p) => /\.(tsx|ts|css)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p),
})
let accentUses = 0
const usesByFile = []
const accentPattern = new RegExp(
  `\\b(?:text|bg|border|ring|fill|stroke|outline|decoration|shadow)-(?:${manifest.accentTokens.join('|')})\\b`,
  'g',
)

for (const file of files) {
  const rel = `${SRC_DIR}/${file}`
  const text = readFileSync(rel, 'utf8')
  const allowed = allowFiles.has(rel)

  if (!allowed) {
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      errs.push(`${rel}: raw hex color "${m[0]}" — colors exist only as @theme tokens in ${STYLES}`)
    }
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?px\b/g)) {
      errs.push(
        `${rel}: raw length "${m[0]}" — use spacing/text utilities (tokens), not pixel literals`,
      )
    }
    if (/\.tsx$/.test(rel) && /style=\{/.test(text)) {
      errs.push(
        `${rel}: inline style={} prop — style through tokens/utilities, or add a reviewed allow entry in ${MANIFEST}`,
      )
    }
    for (const re of ARBITRARY) {
      for (const m of text.matchAll(re)) {
        errs.push(
          `${rel}: Tailwind arbitrary value "${m[0].trim()}" — the design vocabulary is the @theme tokens; extend the tokens in ${STYLES} + ${MANIFEST}, or add a reviewed allow entry`,
        )
      }
    }
  }
  for (const m of text.matchAll(PALETTE)) {
    errs.push(
      `${rel}: "${m[0]}" references an ERASED default-palette color — it compiles to nothing; use the @theme tokens`,
    )
  }

  // ---- 7: accent usage budget (declarations in styles.css don't count) --------
  if (!rel.endsWith('styles.css')) {
    const count = (text.match(accentPattern) ?? []).length
    if (count > 0) {
      accentUses += count
      usesByFile.push(`${rel}: ${count}`)
    }
  }
}

if (accentUses > manifest.accentUsageBudget) {
  errs.push(
    `accent utilities used ${accentUses}× (budget ${manifest.accentUsageBudget}) — the single-accent design dies by a thousand highlights. Remove uses, or raise the budget in ${MANIFEST} as a reviewed decision.\n    ${usesByFile.join('\n    ')}`,
  )
}

failures(GATE, errs)
const contrastNote = Array.isArray(manifest.contrast)
  ? `; ${manifest.contrast.length} contrast pair(s) computed-green across ${1 + themeBlocks.size} theme(s)`
  : ''
ok(
  GATE,
  `${declared.size} oklch tokens + ${Object.keys(manifest.families ?? {}).length} families in lockstep; erasure intact; no raw hex/px/inline-style/arbitrary-value; accent ${accentUses}/${manifest.accentUsageBudget}${contrastNote}`,
)
