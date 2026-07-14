#!/usr/bin/env node
// Gate: i18n — the locale seam is real, and nothing bypasses it.
//
// A Stop-chain step, NOT a member of the 22-gate floor (the floor stays frozen), and
// turn-fatal from baseVersion 0.1.6. Ramped, so an upgraded consumer's existing English
// literals NOTE before they red — projects grow into gates; gates do not ambush an update.
//
// WHY IT IS A GATE AND NOT A GUIDELINE. Before 0.1.6 the desktop app contained zero `Intl.`,
// zero `dir=`, a hardcoded `<html lang="en">`, and ~70 English literals sprinkled across 20
// components. Not because anyone decided against localization — because nothing ever asked.
// Prose in AGENTS.md is advisory; an agent adding a screen next week adds English literals to
// it, and every gate stays green. Single-locale English is a floor you can only hold by
// checking it.
//
// THREE CHECKS.
//
//  1. NO HARDCODED USER-FACING STRING. A literal in a component is a string no translator can
//     reach, no reviewer can grep, and no gate can see. Detected in the places copy actually
//     lives: JSX text children, user-facing JSX attributes (aria-label, title, placeholder,
//     label, alt, description, subtitle), and the object literals that feed them — `label:` in
//     the ROUTES manifest, `description:` in the shortcut registry, `title:`/`subtitle:` in
//     palette commands, column headers in the matrix data module.
//
//  2. Intl AND toLocale* LIVE ONLY IN src/i18n/. Locale is threaded through exactly one
//     module, so it cannot disagree with itself. `.toFixed()` is banned in components for the
//     same reason and it is not pedantry: `.toFixed(2)` hardcodes `.` as the decimal mark, so
//     the matrix rendered "0.75" to a German user who writes "0,75" — and it did so in a
//     function called formatCell, which is exactly where you would look and not see it.
//
//  3. NO DEAD CATALOG STRING. A key nothing renders is copy that rots — translated, reviewed,
//     paid for, and never shown. Dynamically-built keys (`theme.switch.${next}`) are resolved
//     by their static prefix, so the check understands them without being fooled by them.
//
// LIMITS, HONESTLY. This is a text scan, not a compiler: it sees the shapes copy takes, not
// every expression that could produce a string. A message assembled at runtime from fragments,
// or returned by a helper, is invisible to it. That is precisely why the e2e pseudo-locale
// lane exists (e2e/i18n.spec.ts): under `en-XA` every catalog string is visibly mangled, so
// any plain-English text still on screen is BY CONSTRUCTION a string that never went through
// the catalog. The static check is fast and runs every turn; the behavioural one is complete.
// Neither alone would be enough.
//
// Over-detection reds with `tools/i18n-allow.json` as the reviewed escape (malformed or stale
// entries FAIL, never open); it can never fail open.
// SOURCE: docs/harness/gates-catalog.md (i18n gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { blankComments, lineOf } from './lib/source-text.mjs'

const GATE = 'i18n'
const SRC = 'apps/desktop/src'
const I18N_DIR = `${SRC}/i18n`
const CATALOG = `${I18N_DIR}/catalog.ts`
const ALLOW_PATH = 'tools/i18n-allow.json'

if (!existsSync(SRC)) skipOrFail(GATE, 'apps/desktop/src not found (no desktop surface yet)')
if (!existsSync(CATALOG)) {
  // The seam is seedOnInitOnly: an upgraded consumer has no catalog until they adopt it, and
  // a gate that reds on its own absence would be exactly the ambush the ramp doctrine forbids.
  ok(
    GATE,
    `SKIPPED — ${CATALOG} absent, so the locale seam is not adopted and this project ships single-locale. ` +
      'Adopt it with `npx tauri-postgres-agent-harness update --refresh-seeded apps/desktop/src/i18n/` ' +
      '(see docs/harness/gates-catalog.md, "i18n")',
  )
}

// ---- the reviewed escape (the rls-exempt pattern: malformed or stale FAILS, never opens) ----
const allow = new Set()
if (existsSync(ALLOW_PATH)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOW_PATH} is not valid JSON (${e.message}) — the escape list must be reviewable data`,
    )
  }
  const entries = parsed?.allow
  if (!Array.isArray(entries)) {
    fail(
      GATE,
      `${ALLOW_PATH} must be { "comment": …, "allow": [ { "site": "file:line", "reason": non-empty string } ] } — got ${JSON.stringify(parsed)}`,
    )
  }
  for (const entry of entries) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.site === 'string' &&
      /^[^:]+:\d+$/.test(entry.site) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${ALLOW_PATH}: every entry must be { "site": "file:line", "reason": non-empty string } — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.site)
  }
}

const sources = walkFiles(SRC, {
  excludeDirs: new Set(['node_modules', 'i18n']),
  filter: (rel) => /\.tsx?$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel),
}).map((rel) => `${SRC}/${rel}`)

// ---- 1. hardcoded user-facing strings ---------------------------------------------
// Attributes whose value a HUMAN READS. Everything else (className, data-*, id, role, type,
// href, key, name, htmlFor, aria-labelledby/-describedby — which carry ids, not copy) is
// machine-facing and deliberately absent.
const TEXT_ATTRS = ['aria-label', 'aria-description', 'title', 'placeholder', 'label', 'alt']
const ATTR_LITERAL = new RegExp(
  `\\b(${TEXT_ATTRS.join('|')})\\s*=\\s*"([^"]*[A-Za-z]{2}[^"]*)"`,
  'g',
)

// Object-literal copy: `label: 'Home'` in the ROUTES manifest, `description: 'Command palette'`
// in the shortcut registry, `title:`/`subtitle:` in palette commands, matrix column headers.
const OBJECT_LITERAL = /\b(label|title|subtitle|description)\s*:\s*'([^']*[A-Za-z]{2}[^']*)'/g

// JSX text: a run between a tag close and the next tag open, containing two consecutive
// letters. `{expr}` is not text (JSX splits on the brace) and a lone glyph (✕, ×) is not copy.
//
// TypeScript makes this harder than it looks, because `>` is also a generic close and half an
// arrow. Two guards, both load-bearing:
//   (?<!=)  — an arrow's `>` never opens JSX text. Without this, `SHORTCUTS.map((s) => [...])`
//             reports the code that follows it as user-facing copy.
//   =;`$    — excluded from the run. A generic close (`useState<Toast[]>([])`) is followed by
//             CODE, and code has assignments, semicolons and template markers; prose does not.
//             Prose's punctuation (: , . ( ) … —) stays legal, because copy really does use it.
const JSX_TEXT = /(?<!=)>\s*([^<>{}=;`$]*[A-Za-z]{2}[^<>{}=;`$]*?)\s*</g

// A literal that is plainly not copy: a css/token/id-ish word with no spaces and no capital,
// a lone url/path, a data-testid-shaped kebab string.
function looksMachineFacing(text) {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (/^[/#.][\w/#.-]*$/.test(trimmed)) return true // '/healthz', '/matrix', '.foo'
  if (/^[a-z][\w-]*$/.test(trimmed) && !trimmed.includes(' ')) return true // 'gridcell', 'mod+k'
  return false
}

const errs = []

function record(file, text, index, source, what) {
  if (looksMachineFacing(text)) return
  const line = lineOf(source, index)
  if (allow.has(`${file}:${line}`)) return
  errs.push(
    `${file}:${line}: hardcoded user-facing string ${JSON.stringify(text.trim())} (${what}) — a literal in a component is copy no translator can reach and no reviewer can grep. FIX: add a key to ${CATALOG} and render it through \`t('<key>')\` (\`const { t } = useI18n()\` in a component; the plain \`t\` export outside one). If this string is genuinely never shown to a human, add a reviewed {"site": "${file}:${line}", "reason": …} entry to ${ALLOW_PATH}`,
  )
}

for (const file of sources) {
  const source = blankComments(readFileSync(file, 'utf8'))
  for (const m of source.matchAll(ATTR_LITERAL))
    record(file, m[2], m.index, source, `${m[1]} attribute`)
  for (const m of source.matchAll(OBJECT_LITERAL))
    record(file, m[2], m.index, source, `${m[1]}: property`)
  // JSX text ONLY in .tsx. A plain .ts file has no JSX, but it does have generics — and
  // `useListQuery<T>(fetcher: ListFetcher<T>)` looks exactly like a tag with text between it.
  // The attribute and object-literal rules still run there (routes.ts, registry.ts,
  // matrixData.ts hold copy), so nothing is lost by not looking for JSX where there is none.
  if (!file.endsWith('.tsx')) continue
  for (const m of source.matchAll(JSX_TEXT)) record(file, m[1], m.index, source, 'JSX text')
}

// ---- 2. the Intl boundary ----------------------------------------------------------
const INTL_USE = /\bIntl\s*\.|\.toLocale[A-Z]\w*\s*\(|\.toFixed\s*\(/g
const boundary = []
for (const file of sources) {
  const source = blankComments(readFileSync(file, 'utf8'))
  for (const m of source.matchAll(INTL_USE)) {
    const line = lineOf(source, m.index)
    if (allow.has(`${file}:${line}`)) continue
    boundary.push(
      `${file}:${line}: \`${m[0].trim()}\` outside ${I18N_DIR}/ — locale-sensitive formatting lives in ONE module or it disagrees with itself. \`.toFixed(2)\` in particular hardcodes \`.\` as the decimal mark, so a German reader gets "0.75" where they write "0,75". FIX: use formatNumber / formatCellValue / formatDate / formatRelativeTime from ${I18N_DIR}/`,
    )
  }
}
errs.push(...boundary)

// ---- 3. no dead catalog string -----------------------------------------------------
const catalogSource = blankComments(readFileSync(CATALOG, 'utf8'))
const keys = [...catalogSource.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1])
if (keys.length === 0) {
  fail(GATE, `${CATALOG} declares no message keys — the catalog cannot be empty`)
}

// Every string literal anywhere in the app (including src/i18n consumers) plus the static
// PREFIX of every template literal, so `t(\`theme.switch.${next}\`)` marks the whole family used.
const referenced = new Set()
const prefixes = []
for (const file of [
  ...sources,
  ...walkFiles(I18N_DIR, { filter: (r) => /\.tsx?$/.test(r) && !/\.test\./.test(r) }).map(
    (r) => `${I18N_DIR}/${r}`,
  ),
]) {
  if (file === CATALOG) continue
  const source = blankComments(readFileSync(file, 'utf8'))
  for (const m of source.matchAll(/['"]([\w.-]+)['"]/g)) referenced.add(m[1])
  for (const m of source.matchAll(/`([\w.-]*)\$\{/g)) {
    if (m[1] !== '') prefixes.push(m[1])
  }
}
const dead = keys.filter(
  (key) => !referenced.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
)
for (const key of dead) {
  errs.push(
    `${CATALOG}: message key '${key}' is never rendered — copy nothing shows is copy that rots (translated, reviewed, and dead). Remove it, or render it.`,
  )
}

// ---- ramp + verdict ----------------------------------------------------------------
if (errs.length > 0 && rampNote(GATE, '0.1.6', `${errs.length} i18n finding(s)`)) {
  for (const e of errs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  ok(
    GATE,
    `${keys.length} message keys, ${sources.length} source file(s) — findings ramped to 0.1.6`,
  )
}
failures(
  GATE,
  errs,
  `  The locale seam: every user-facing string is a key in ${CATALOG}, and locale-sensitive formatting lives only in ${I18N_DIR}/ (see docs/harness/gates-catalog.md, "i18n"). The e2e pseudo-locale lane proves it behaviourally.`,
)
ok(GATE, `${keys.length} message keys, ${sources.length} source file(s) scanned, no hardcoded copy`)
