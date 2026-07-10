#!/usr/bin/env node
// Gate: build — the desktop SPA must actually build, and the produced bundle must be
// PURE: no server/database modules, no secret-shaped strings, no privileged DSNs.
// Bundle purity is the runtime backstop for the depcruise/lint rules — a transitive
// import that sneaks past static analysis still shows up in the emitted JS.
// SOURCE: docs/harness/README.md (build gate; desktop-bundle purity) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'build'
const APP = 'apps/desktop'

if (!existsSync(`${APP}/package.json`)) skipOrFail(GATE, `${APP} not found (no desktop surface yet)`)
if (!existsSync('node_modules')) skipOrFail(GATE, 'node_modules missing — run pnpm install')

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

// Forbidden markers in the shipped client bundle.
const FORBIDDEN = [
  ['drizzle-orm', 'ORM code in the client bundle (server/db leak)'],
  ['MIGRATOR_DATABASE_URL', 'privileged DSN name in the client bundle'],
  ['postgres://', 'connection string in the client bundle'],
  ['TAURI_SIGNING', 'signing-key material reference in the client bundle'],
  ['BEGIN PRIVATE KEY', 'private key material in the client bundle'],
]

const hits = []
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(js|css|html)$/.test(entry)) {
      const text = readFileSync(p, 'utf8')
      for (const [marker, why] of FORBIDDEN) {
        if (text.includes(marker)) hits.push(`${p}: contains "${marker}" — ${why}`)
      }
    }
  }
})(dist)

failures(GATE, hits)
ok(GATE, 'desktop bundle builds and is pure (no server/db/secret markers)')
