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
//      lightness steps perceptually comparable and the documented WCAG contrast
//      table in styles.css recomputable.
//   4. source scan — no raw hex colors, no raw px lengths, no inline style={}
//      props, and no references to erased default-palette utilities anywhere in
//      the desktop source (manifest.allow lists file-level exemptions, each with
//      a reason).
//   5. accent budget — the near-monochrome + single-accent design survives on a
//      usage BUDGET: accent-utility occurrences stay <= the documented budget.
// SOURCE: docs/harness/gates-catalog.md (styleguide gate) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

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
const declared = new Map()
for (const m of theme.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  declared.set(m[1], m[2].trim())
}
if (declared.size === 0) fail(GATE, '@theme declares no --color-* tokens — vacuous theme')

for (const [token, value] of declared) {
  if (!/^oklch\(/.test(value)) {
    errs.push(
      `--color-${token} is "${value}" — all color tokens must be oklch() (one color model keeps the contrast table in ${STYLES} honest)`,
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

// ---- 4: source scan — escapes from the token system ----------------------------
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

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx|ts|css)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const files = walk(SRC_DIR)
let accentUses = 0
const usesByFile = []
const accentPattern = new RegExp(
  `\\b(?:text|bg|border|ring|fill|stroke|outline|decoration|shadow)-(?:${manifest.accentTokens.join('|')})\\b`,
  'g',
)

for (const file of files) {
  const rel = file.split('\\').join('/')
  const text = readFileSync(file, 'utf8')
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
  }
  for (const m of text.matchAll(PALETTE)) {
    errs.push(
      `${rel}: "${m[0]}" references an ERASED default-palette color — it compiles to nothing; use the @theme tokens`,
    )
  }

  // ---- 5: accent usage budget (declarations in styles.css don't count) --------
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
ok(
  GATE,
  `${declared.size} oklch tokens + ${Object.keys(manifest.families ?? {}).length} families in lockstep; erasure intact; no raw hex/px/inline-style; accent ${accentUses}/${manifest.accentUsageBudget}`,
)
