// tools/lib/bundle-measure.mjs — the ONE implementation of "how many gzip bytes
// is the bundle". The build gate (tools/build-check.mjs) and the baseline
// regenerator (tools/perf-baseline.mjs, `pnpm perf:baseline`) both measure
// through THIS module, so the ratchet can never compare a gate-measured byte
// against a differently-measured baseline byte. Bytes are hardware-independent:
// the baseline×ratioCap delta check is deterministic everywhere, agent time
// included — unlike wall-clock budgets, which stay in their own gate.
// SOURCE: docs/harness/gates-catalog.md (build gate — gzip ratchet) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { walkFiles } from './fs-walk.mjs'

export const BASELINE_FILE = 'tools/perf-baseline.json'
// Canonical spelling of the regeneration ceremony (package.json script →
// node tools/perf-baseline.mjs). Installs whose seeded package.json predates
// the script run the node command directly — the FIX lines name both.
export const BASELINE_COMMAND = 'pnpm perf:baseline'

// Defaults seeded into a from-scratch baseline; both survive regeneration once
// a human has tuned them (composeBaseline preserves the previous values).
const DEFAULT_RATIO_CAP = 1.25
// Bounds the NIGHTLY Windows NSIS artifact (quality-gate.yml desktop-windows:
// a --debug build embedding the ~150 MB offline WebView2 installer) — a coarse
// bundled-dependency canary, not a ship-size promise. The first nightly run
// prints the real size; ratchet DOWN in a reviewed commit.
const DEFAULT_INSTALLER_BUDGET_BYTES = 350 * 1024 * 1024
const DEFAULT_COMMENT =
  'Committed gzip baseline for the build gate byte-true ratchet (tools/build-check.mjs): ' +
  'the bundle fails when measured gzip bytes exceed baseline × ratioCap — long before the ' +
  'absolute budgets in tools/bundle-budget.json (~3x headroom) would notice. Bytes are ' +
  'hardware-independent, so this check is deterministic everywhere, agent time included. ' +
  'Regenerate ONLY via `pnpm perf:baseline` after a DELIBERATE size change and commit the ' +
  'diff for review — the file is write-guard-protected. installerBudgetBytes bounds the ' +
  'nightly Windows NSIS artifact (debug build embedding the ~150 MB offline WebView2; a ' +
  'coarse bundled-dependency canary) — the first nightly prints the real size; ratchet it ' +
  'DOWN in a reviewed commit.'

const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

// Vite content hashes are appended as `-<8 base64url chars>` before the
// extension ("assets/index-BPEV55Z5.js"). Stripping the hash — and the
// hashed-asset directory prefix — yields a logical chunk key that stays stable
// across builds ("index.js", "MatrixScreen.js"): key by WHAT the chunk is, not
// by the bytes it happens to contain today.
function logicalChunkKey(rel) {
  const base = rel.split('/').pop() ?? rel
  return base.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/, '')
}

// Walk the emitted dist/ EXHAUSTIVELY (same no-exclude contract as the purity
// scan) and gzip every file: totalBytes is the ratchet's primary invariant;
// chunks maps each logical JS chunk key to its gzip bytes (two files stripping
// to the same key sum — deterministic, and renames still land on the total).
export function measureDist(dist) {
  const files = []
  for (const rel of walkFiles(dist)) {
    const gzipBytes = gzipSync(readFileSync(`${dist}/${rel}`)).length
    files.push({ rel, gzipBytes, isJs: /\.js$/.test(rel) })
  }
  const chunks = {}
  for (const f of files) {
    if (!f.isJs) continue
    const key = logicalChunkKey(f.rel)
    chunks[key] = (chunks[key] ?? 0) + f.gzipBytes
  }
  return {
    files,
    totalBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0),
    chunks,
  }
}

// Parse + shape-check a baseline document. Throws (message only, no path — the
// caller owns the naming) on ANY defect: the ratchet fails closed on
// unreviewable data, never open.
export function parseBaseline(raw) {
  let b
  try {
    b = JSON.parse(raw)
  } catch (e) {
    throw new Error(`is not valid JSON (${e.message})`)
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new Error('must be a JSON object')
  }
  if (
    b.gzip === null ||
    typeof b.gzip !== 'object' ||
    Array.isArray(b.gzip) ||
    !isPositiveNumber(b.gzip.total)
  ) {
    throw new Error('must carry gzip.total as a positive byte count')
  }
  if (typeof b.ratioCap !== 'number' || !Number.isFinite(b.ratioCap) || b.ratioCap < 1) {
    throw new Error('must carry ratioCap >= 1 (the growth ratio the gate allows over the baseline)')
  }
  if (b.gzip.chunks !== undefined) {
    if (
      b.gzip.chunks === null ||
      typeof b.gzip.chunks !== 'object' ||
      Array.isArray(b.gzip.chunks)
    ) {
      throw new Error('gzip.chunks, when present, must be an object of { "<chunk key>": bytes }')
    }
    for (const [key, bytes] of Object.entries(b.gzip.chunks)) {
      if (!isPositiveNumber(bytes)) {
        throw new Error(`gzip.chunks[${JSON.stringify(key)}] must be a positive byte count`)
      }
    }
  }
  if (b.installerBudgetBytes !== undefined && !isPositiveNumber(b.installerBudgetBytes)) {
    throw new Error('installerBudgetBytes, when present, must be a positive byte count')
  }
  return b
}

// The ratchet proper: measured vs baseline × ratioCap, total always, per chunk
// when the baseline declares chunks. Exactly AT the cap is green — the ratchet
// fails on strict growth past it. A baseline chunk key the build no longer
// emits is a NOTE, never a red: the total still bounds the bytes, and the
// refreshed map arrives with the next reviewed re-baseline.
export function ratchetFindings({ totalBytes, chunks }, baseline) {
  const errs = []
  const notes = []
  const fix = `find the regression, or after a DELIBERATE size change re-baseline via \`${BASELINE_COMMAND}\` in a reviewed commit`
  const totalCap = baseline.gzip.total * baseline.ratioCap
  if (totalBytes > totalCap) {
    errs.push(
      `bundle total ${String(totalBytes)} B gzip exceeds the committed ratchet: baseline ${String(baseline.gzip.total)} B × ratioCap ${String(baseline.ratioCap)} = ${String(Math.floor(totalCap))} B (${BASELINE_FILE}) — ${fix}`,
    )
  }
  for (const [key, baseBytes] of Object.entries(baseline.gzip.chunks ?? {})) {
    const nowBytes = chunks[key]
    if (nowBytes === undefined) {
      notes.push(
        `baseline chunk "${key}" is no longer emitted (renamed or merged; the total ratchet still bounds the bytes) — refresh the chunk map via \`${BASELINE_COMMAND}\` in a reviewed commit`,
      )
      continue
    }
    const chunkCap = baseBytes * baseline.ratioCap
    if (nowBytes > chunkCap) {
      errs.push(
        `chunk "${key}": ${String(nowBytes)} B gzip exceeds the committed ratchet: baseline ${String(baseBytes)} B × ratioCap ${String(baseline.ratioCap)} = ${String(Math.floor(chunkCap))} B (${BASELINE_FILE}) — ${fix}`,
      )
    }
  }
  return { errs, notes }
}

// Build the next baseline document from a fresh measurement, preserving the
// human-tuned knobs (comment, ratioCap, installerBudgetBytes) of the previous
// baseline when they are usable — regeneration refreshes the MEASURED numbers,
// never silently resets a reviewed policy value.
export function composeBaseline({ measured, prev }) {
  return {
    comment:
      typeof prev?.comment === 'string' && prev.comment.trim() !== ''
        ? prev.comment
        : DEFAULT_COMMENT,
    generatedBy: BASELINE_COMMAND,
    gzip: {
      chunks: { ...measured.chunks },
      total: measured.totalBytes,
    },
    installerBudgetBytes: isPositiveNumber(prev?.installerBudgetBytes)
      ? prev.installerBudgetBytes
      : DEFAULT_INSTALLER_BUDGET_BYTES,
    ratioCap:
      typeof prev?.ratioCap === 'number' && Number.isFinite(prev.ratioCap) && prev.ratioCap >= 1
        ? prev.ratioCap
        : DEFAULT_RATIO_CAP,
  }
}

// Stable serialization: every object level sorted by key, 2-space indent,
// trailing newline — byte-identical output for identical measurements, so a
// re-baseline diff shows ONLY what actually changed.
export function serializeBaseline(baseline) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sortDeep(v[k])]),
      )
    }
    return v
  }
  return `${JSON.stringify(sortDeep(baseline), null, 2)}\n`
}

// Human-readable regeneration report: what moved, by how much. Pure — the
// regenerator prints these lines, the tests assert them without a vite build.
export function diffBaseline(prev, next) {
  if (!prev) {
    return [
      `no previous ${BASELINE_FILE} — seeding gzip total ${String(next.gzip.total)} B, ${String(Object.keys(next.gzip.chunks).length)} chunk key(s)`,
    ]
  }
  const lines = []
  const pct = (from, to) =>
    from > 0 ? `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(1)}%` : 'n/a'
  if (prev.gzip.total !== next.gzip.total) {
    lines.push(
      `gzip total: ${String(prev.gzip.total)} B → ${String(next.gzip.total)} B (${pct(prev.gzip.total, next.gzip.total)})`,
    )
  } else {
    lines.push(`gzip total: unchanged at ${String(next.gzip.total)} B`)
  }
  const prevChunks = prev.gzip.chunks ?? {}
  const keys = [...new Set([...Object.keys(prevChunks), ...Object.keys(next.gzip.chunks)])].sort()
  for (const key of keys) {
    const from = prevChunks[key]
    const to = next.gzip.chunks[key]
    if (from === undefined) lines.push(`chunk "${key}": NEW at ${String(to)} B`)
    else if (to === undefined) lines.push(`chunk "${key}": REMOVED (was ${String(from)} B)`)
    else if (from !== to)
      lines.push(`chunk "${key}": ${String(from)} B → ${String(to)} B (${pct(from, to)})`)
  }
  return lines
}
