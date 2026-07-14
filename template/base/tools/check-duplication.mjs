#!/usr/bin/env node
// Gate: duplication (G17) — copy-paste rot cannot ship green. No machine check caught a
// block pasted across files, so the maintainability pillar's "deterministically
// world-class" claim was violable by the oldest smell there is. This is a zero-dep,
// deterministic token clone detector over apps/*/src + packages/*/src: it tokenizes each
// source (comments and whitespace stripped, string/number literals normalized so a paste
// that only swapped a constant still matches), slides a MIN_TOKENS window, and flags any
// run of ≥ MIN_TOKENS tokens that appears in two places. Exact-ish (type-1) matching, so
// a red is a genuine paste, not two functions that merely rhyme.
//
// NOT a floor step (the 22-gate floor is frozen): this runs as a Stop-chain step and a
// blocking CI lane. Ramped — on a pre-0.1.6 baseVersion install it emits a NOTE instead
// of failing, so a consumer's pre-existing copy-paste never ambushes an `update`; graduate
// by sweeping the clones and bumping baseVersion (docs/runbooks/harness-upgrade.md).
// Reviewed accepted clones live in tools/duplication-allow.json (by content fingerprint,
// so an accepted clone stays accepted when it moves).
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'duplication'
const ALLOW = 'tools/duplication-allow.json'

// A clone must be at least this many tokens AND span this many lines — high enough that
// two structurally-similar-but-independent blocks don't trip, low enough that a real
// pasted function (~15+ lines) is caught. Tuned against the DRY reference scaffold.
const MIN_TOKENS = 70
const MIN_LINES = 6

// Scan only hand-written product source. Generated bindings, tests (they legitimately
// repeat setup), and type decls are excluded.
const SCAN_ROOTS = []
for (const scope of ['apps', 'packages']) {
  if (!existsSync(scope)) continue
  for (const d of readdirSync(scope)) {
    const src = join(scope, d, 'src')
    if (existsSync(src)) SCAN_ROOTS.push(src)
  }
}
if (SCAN_ROOTS.length === 0) {
  skipOrFail(GATE, 'no apps/*/src or packages/*/src to scan (no product source yet)')
}

// ---- reviewed exemptions ------------------------------------------------------------
const allow = new Set()
if (existsSync(ALLOW)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOW} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.allow)) {
    fail(
      GATE,
      `${ALLOW} must carry an "allow" ARRAY of {"fingerprint": string, "reason": string} entries`,
    )
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.fingerprint === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${ALLOW}: every entry must be {"fingerprint": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.fingerprint)
  }
}

// ---- tokenizer ----------------------------------------------------------------------
// One regex, one pass. Whitespace and comments are matched (and skipped); strings /
// template literals become a single normalized `"S"` token and numbers `"N"`, so a paste
// that changed only a literal still matches; every other identifier/keyword/operator/
// punctuation char is a literal token. Regex literals are not special-cased (rare in
// product source; at worst a `/` splits a would-be clone, never a false match).
const TOKEN_RE =
  /(\s+)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\d[\w.]*)|([A-Za-z_$][\w$]*|[^\s])/g

/** @returns {{ value: string, line: number }[]} */
function tokenize(text) {
  const tokens = []
  let line = 1
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, ws, lineComment, blockComment, str, num, other] = m
    if (ws !== undefined || lineComment !== undefined) {
      line += (whole.match(/\n/g) ?? []).length
      continue
    }
    if (blockComment !== undefined || str !== undefined) {
      const startLine = line
      line += (whole.match(/\n/g) ?? []).length
      if (blockComment !== undefined) continue
      tokens.push({ value: 'S', line: startLine })
      continue
    }
    if (num !== undefined) {
      tokens.push({ value: 'N', line })
      continue
    }
    if (other !== undefined) tokens.push({ value: other, line })
  }
  return tokens
}

// ---- fingerprint + extend clone detection -------------------------------------------
const files = []
for (const root of SCAN_ROOTS) {
  for (const rel of walkFiles(root, {
    filter: (p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p),
  })) {
    const path = `${root}/${rel}`
    // The committed specta bindings are generated; never a maintainability concern.
    if (/\/ipc\/bindings\.ts$/.test(path)) continue
    files.push({ path, tokens: tokenize(readFileSync(path, 'utf8')) })
  }
}

const hashWindow = (tokens, start) => {
  let s = ''
  for (let k = 0; k < MIN_TOKENS; k += 1) s += `${tokens[start + k].value} `
  return createHash('sha1').update(s).digest('hex')
}

// windowHash -> first place it was seen. A later window matching it is a clone tail; we
// extend token-by-token to the maximal matching run and record the region once.
const firstSeen = new Map()
const clones = []
for (const file of files) {
  const { tokens } = file
  let i = 0
  while (i + MIN_TOKENS <= tokens.length) {
    const h = hashWindow(tokens, i)
    const prev = firstSeen.get(h)
    // Same-file self-overlap (a window matching itself shifted < MIN_TOKENS) is not a clone.
    const selfOverlap = prev !== undefined && prev.file === file && i - prev.index < MIN_TOKENS
    if (prev !== undefined && !selfOverlap) {
      const sameFile = prev.file === file
      let len = MIN_TOKENS
      while (
        i + len < tokens.length &&
        // Only within ONE file must the two regions not overlap; across files there is
        // no overlap to guard, so a cross-file clone extends to its full matching run.
        (!sameFile || prev.index + len < i) &&
        prev.file.tokens[prev.index + len] !== undefined &&
        prev.file.tokens[prev.index + len].value === tokens[i + len].value
      ) {
        len += 1
      }
      const aStart = prev.file.tokens[prev.index].line
      const aEnd = prev.file.tokens[prev.index + len - 1].line
      const bStart = tokens[i].line
      const bEnd = tokens[i + len - 1].line
      // A stable content fingerprint (normalized token run), so a reviewed-accepted clone
      // stays accepted after it moves lines.
      const fp = createHash('sha1')
        .update(
          tokens
            .slice(i, i + len)
            .map((t) => t.value)
            .join(' '),
        )
        .digest('hex')
        .slice(0, 12)
      if (Math.max(aEnd - aStart, bEnd - bStart) + 1 >= MIN_LINES && !allow.has(fp)) {
        clones.push({
          fp,
          tokens: len,
          a: `${prev.file.path}:${aStart}-${aEnd}`,
          b: `${file.path}:${bStart}-${bEnd}`,
        })
      }
      i += len // skip past the clone
    } else {
      if (prev === undefined) firstSeen.set(h, { file, index: i })
      i += 1
    }
  }
}

const errs = clones.map(
  (c) =>
    `clone (${c.tokens} tokens, fingerprint ${c.fp}) — ${c.a} duplicates ${c.b}. Extract the shared logic into one function/module; if the repetition is genuinely irreducible, add {"fingerprint": "${c.fp}", "reason": …} to ${ALLOW} (reviewed).`,
)

// Ramp: a pre-0.1.6 install carries copy-paste this gate never held it to — NOTE, don't
// ambush the update. A fresh 0.1.6 scaffold (or a graduated one) is turn-fatal.
if (errs.length > 0 && rampNote(GATE, '0.1.6', `${errs.length} code clone(s)`)) {
  ok(GATE, `${errs.length} clone(s) held as a ramp NOTE (pre-0.1.6 baseVersion)`)
}

failures(GATE, errs)
ok(
  GATE,
  `${files.length} source file(s) scanned, no clones ≥ ${MIN_TOKENS} tokens / ${MIN_LINES} lines`,
)
