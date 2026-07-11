#!/usr/bin/env node
// Gate: build — the desktop SPA must actually build, the produced bundle must be
// PURE (no server/database modules, no secret-shaped strings, no privileged DSNs),
// and it must fit the BYTE BUDGETS in tools/bundle-budget.json (gzip, per-chunk and
// total). Bundle purity is the runtime backstop for the depcruise/lint rules — a
// transitive import that sneaks past static analysis still shows up in the emitted
// JS. The budget is the deterministic performance floor: a 15 MB unsplit bundle is
// a shipped regression whether or not anyone profiles it.
// SOURCE: docs/harness/README.md (build gate; desktop-bundle purity) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fail, failures, ok, skipOrFail, stampGate } from './lib/gate.mjs'
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
  execSync(`pnpm --filter desktop exec vite build`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  fail(GATE, `vite build failed:\n${(e.stderr?.toString() ?? e.message).slice(-2000)}`)
}

const dist = join(APP, 'dist')
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
const files = [] // { path, gzipBytes, isJs }
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else {
      const raw = readFileSync(p)
      files.push({ path: p, gzipBytes: gzipSync(raw).length, isJs: /\.js$/.test(entry) })
      if (/\.(js|css|html)$/.test(entry)) {
        const text = raw.toString('utf8')
        for (const [marker, why] of FORBIDDEN) {
          if (text.includes(marker)) hits.push(`${p}: contains "${marker}" — ${why}`)
        }
      }
    }
  }
})(dist)

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
  const totalKb = kb(files.reduce((sum, f) => sum + f.gzipBytes, 0))
  const biggestChunk = files.filter((f) => f.isJs).sort((a, b) => b.gzipBytes - a.gzipBytes)[0]
  const biggestAsset = files.filter((f) => !f.isJs).sort((a, b) => b.gzipBytes - a.gzipBytes)[0]

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
      `${biggestChunk.path}: ${kb(biggestChunk.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestChunkGzipKb)} KB per-chunk budget — code-split the entry`,
    )
  }
  if (
    typeof budget.largestAssetGzipKb === 'number' &&
    biggestAsset !== undefined &&
    kb(biggestAsset.gzipBytes) > budget.largestAssetGzipKb
  ) {
    hits.push(
      `${biggestAsset.path}: ${kb(biggestAsset.gzipBytes).toFixed(1)} KB gzip exceeds the ${String(budget.largestAssetGzipKb)} KB per-asset budget`,
    )
  }
} else {
  hits.push(
    `${BUDGET_FILE} missing — the bundle has no byte budget; restore it (write-guard-protected data)`,
  )
}

failures(GATE, hits)
recordGreen()
ok(GATE, 'desktop bundle builds, is pure, and fits the byte budgets')
