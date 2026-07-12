#!/usr/bin/env node
// Gate: build — the desktop SPA must actually build, the produced bundle must be
// PURE (no server/database modules, no secret-shaped strings, no privileged DSNs),
// and it must fit the BYTE BUDGETS in tools/bundle-budget.json (gzip, per-chunk and
// total). Bundle purity is the runtime backstop for the depcruise/lint rules — a
// transitive import that sneaks past static analysis still shows up in the emitted
// JS. The budget is the deterministic performance floor: a 15 MB unsplit bundle is
// a shipped regression whether or not anyone profiles it.
//
// RATCHET (v0.1.5): the absolute budgets carry ~3x headroom by design, so a 2-3x
// regression used to ship green. When tools/perf-baseline.json exists (committed
// gzip bytes, regenerated ONLY by `pnpm perf:baseline` in a reviewed commit), the
// gate ALSO fails on measured > baseline × ratioCap — total always, per logical
// chunk when declared. Bytes are hardware-independent: deterministic everywhere,
// agent time included. No baseline (a pre-0.1.5 install) → a NOTE names the file
// and the command, and the absolute-cap behavior stays byte-identical; a
// MALFORMED baseline fails closed. Measurement lives in lib/bundle-measure.mjs,
// shared with the regenerator, so the two can never measure differently.
// SOURCE: docs/harness/README.md (build gate; desktop-bundle purity) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import {
  BASELINE_COMMAND,
  BASELINE_FILE,
  measureDist,
  parseBaseline,
  ratchetFindings,
} from './lib/bundle-measure.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'build'
const APP = 'apps/desktop'
const BUDGET_FILE = 'tools/bundle-budget.json'

if (!existsSync(`${APP}/package.json`))
  skipOrFail(GATE, `${APP} not found (no desktop surface yet)`)
if (!existsSync('node_modules')) skipOrFail(GATE, 'node_modules missing — run pnpm install')

// Content-addressed local skip: a full vite build is the chain's most expensive
// step, and unchanged inputs (declared in lib/stamp-inputs.mjs) cannot change
// its verdict. CI always builds for real.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

try {
  runCmd(`pnpm --filter desktop exec vite build`)
} catch (e) {
  fail(GATE, `vite build failed:\n${(e.stderr?.toString() ?? e.message).slice(-2000)}`)
}

const dist = `${APP}/dist`
if (!existsSync(dist)) fail(GATE, `vite build produced no ${dist}/`)

// Forbidden markers in the shipped client bundle. postgresql:// is the
// spec-equal alias of postgres:// — matching only one was a purity hole.
const FORBIDDEN = [
  ['drizzle-orm', 'ORM code in the client bundle (server/db leak)'],
  ['MIGRATOR_DATABASE_URL', 'privileged DSN name in the client bundle'],
  ['postgres://', 'connection string in the client bundle'],
  ['postgresql://', 'connection string in the client bundle'],
  ['TAURI_SIGNING', 'signing-key material reference in the client bundle'],
  ['BEGIN PRIVATE KEY', 'private key material in the client bundle'],
  ['BEGIN RSA PRIVATE KEY', 'private key material in the client bundle'],
]

const hits = []
// dist is walked EXHAUSTIVELY (no exclude set): purity markers must see every
// emitted text file. Byte accounting happens in the SHARED measurer below.
for (const rel of walkFiles(dist)) {
  if (!/\.(js|css|html)$/.test(rel)) continue
  const p = `${dist}/${rel}`
  const text = readFileSync(p).toString('utf8')
  for (const [marker, why] of FORBIDDEN) {
    if (text.includes(marker)) hits.push(`${p}: contains "${marker}" — ${why}`)
  }
}

// One measurement for BOTH byte checks (absolute budgets + ratchet), through the
// same lib the `pnpm perf:baseline` regenerator uses — gate and baseline can
// never disagree about what a byte is.
const measured = measureDist(dist)

// Byte budgets: gzip (what the WebView actually parses off disk is closer to
// raw, but gzip normalizes minifier noise and matches how budgets are quoted).
// tools/bundle-budget.json is write-guard-protected — raising a budget is a
// human decision with a diff, never an agent convenience.
if (existsSync(BUDGET_FILE)) {
  let budget
  try {
    budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${BUDGET_FILE} is not valid JSON (${e.message}) — the budget must be reviewable data`,
    )
  }
  const kb = (bytes) => bytes / 1024
  const totalKb = kb(measured.totalBytes)
  const byBytes = (a, b) => b.gzipBytes - a.gzipBytes
  const biggestChunk = measured.files.filter((f) => f.isJs).sort(byBytes)[0]
  const biggestAsset = measured.files.filter((f) => !f.isJs).sort(byBytes)[0]

  if (typeof budget.totalGzipKb === 'number' && totalKb > budget.totalGzipKb) {
    hits.push(
      `bundle total ${totalKb.toFixed(1)} KB gzip exceeds the ${String(budget.totalGzipKb)} KB budget (${BUDGET_FILE}) — split/lazy-load or (human decision) raise the budget`,
    )
  }
  if (
    typeof budget.largestChunkGzipKb === 'number' &&
    biggestChunk !== undefined &&
    kb(biggestChunk.gzipBytes) > budget.largestChunkGzipKb
  ) {
    hits.push(
      `${dist}/${biggestChunk.rel}: ${kb(biggestChunk.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestChunkGzipKb)} KB per-chunk budget — code-split the entry`,
    )
  }
  if (
    typeof budget.largestAssetGzipKb === 'number' &&
    biggestAsset !== undefined &&
    kb(biggestAsset.gzipBytes) > budget.largestAssetGzipKb
  ) {
    hits.push(
      `${dist}/${biggestAsset.rel}: ${kb(biggestAsset.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestAssetGzipKb)} KB per-asset budget`,
    )
  }
} else {
  hits.push(
    `${BUDGET_FILE} missing — the bundle has no byte budget; restore it (write-guard-protected data)`,
  )
}

// The gzip ratchet: committed baseline × ratioCap, byte-true. Self-disables
// LOUDLY when the baseline is absent (a 0.1.4-vintage install keeps exactly the
// absolute-cap behavior above); fails CLOSED when it is malformed — an
// unreviewable ratchet must never fail open.
if (existsSync(BASELINE_FILE)) {
  let baseline
  try {
    baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${BASELINE_FILE} ${e.message} — the ratchet FAILS CLOSED on unreviewable data; regenerate with \`${BASELINE_COMMAND}\` in a reviewed commit (the file is write-guard-protected)`,
    )
  }
  const { errs, notes } = ratchetFindings(measured, baseline)
  for (const note of notes) console.log(`${GATE}: NOTE — ${note}`)
  hits.push(...errs)
} else {
  console.log(
    `${GATE}: NOTE — ${BASELINE_FILE} absent: the gzip ratchet is OFF and only the absolute byte budgets in ${BUDGET_FILE} apply (~3x headroom — a sub-budget regression ships green). Generate the committed baseline with \`${BASELINE_COMMAND}\` (or \`node tools/perf-baseline.mjs\` on installs whose package.json predates the script) and commit it in a reviewed diff; see docs/runbooks/harness-upgrade.md (content-conditional checks)`,
  )
}

failures(GATE, hits)
recordGreen()
ok(
  GATE,
  `desktop bundle builds, is pure, and fits the byte budgets (gzip total ${String(measured.totalBytes)} B)`,
)
