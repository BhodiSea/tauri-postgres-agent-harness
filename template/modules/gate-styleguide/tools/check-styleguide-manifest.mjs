#!/usr/bin/env node
// Gate: styleguide (OPT-IN — uncomment the ['styleguide', ...] line in
// tools/harness.config.mjs after enabling the gate-styleguide module).
//
// The design system is DATA, and this gate keeps it honest. Three checks over the
// Tailwind v4 CSS-first theme in apps/desktop/src/styles.css:
//   1. token closure — the @theme --color-* set and tools/styleguide.manifest.json
//      must match bidirectionally: an undocumented token cannot ship, and the
//      manifest cannot advertise a token that no longer exists.
//   2. OKLCH-only — every color token is an oklch() value. One color model keeps
//      lightness steps perceptually comparable and the documented WCAG contrast
//      table in styles.css recomputable; a stray hex/hsl silently invalidates it.
//   3. accent budget — the near-monochrome + single-accent design survives on a
//      usage BUDGET: occurrences of accent utilities across the desktop source
//      must stay <= the documented budget. Raising the budget is a reviewed,
//      deliberate diff of the manifest — not a drive-by class.
// SOURCE: docs/harness/gates-catalog.md (gate-styleguide module)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'styleguide'
const STYLES = 'apps/desktop/src/styles.css'
const MANIFEST = 'tools/styleguide.manifest.json'
const SRC_DIR = 'apps/desktop/src'

if (!existsSync(STYLES)) skipOrFail(GATE, `${STYLES} not found (no desktop styles surface yet)`)
if (!existsSync(MANIFEST)) fail(GATE, `${MANIFEST} missing — the module ships it; restore it`)

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const css = readFileSync(STYLES, 'utf8')
const errs = []

// ---- 1 + 2: parse the @theme block; assert closure and OKLCH-only ------------
const themeMatch = css.match(/@theme\s*\{([\s\S]*?)\}/)
if (!themeMatch) fail(GATE, `${STYLES} has no @theme block — the token source of truth is gone`)

const declared = new Map()
for (const m of themeMatch[1].matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
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

// ---- 3: accent usage budget ---------------------------------------------------
const accentPattern = new RegExp(
  `\\b(?:text|bg|border|ring|fill|stroke|outline|decoration|shadow)-(?:${manifest.accentTokens.join('|')})\\b`,
  'g',
)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx|ts|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

let accentUses = 0
const usesByFile = []
for (const file of walk(SRC_DIR)) {
  if (file.endsWith('styles.css')) continue // declarations don't count as usage
  const count = (readFileSync(file, 'utf8').match(accentPattern) ?? []).length
  if (count > 0) {
    accentUses += count
    usesByFile.push(`${file}: ${count}`)
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
  `${declared.size} oklch tokens in lockstep with the manifest; accent usage ${accentUses}/${manifest.accentUsageBudget}`,
)
