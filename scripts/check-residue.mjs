#!/usr/bin/env node
// Shared placeholder-residue scanner: fail LOUD on any unrendered
// {{PLACEHOLDER}} left in a rendered scaffold. One implementation for every
// consumer — the installer lifecycle tests, the selftest bootstrap lane, and
// the module render lane — so the residue definition can never fork.
//   usage: node scripts/check-residue.mjs <scaffold-dir>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: check-residue.mjs <scaffold-dir>')
  process.exit(1)
}
const dir = resolve(root)

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|exe|dll|so|dylib|gguf|node|lock)$/i
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g

const hits = []
;(function walk(d) {
  for (const entry of readdirSync(d)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'target' || entry === 'dist') continue
    const p = join(d, entry)
    if (statSync(p).isDirectory()) {
      walk(p)
      continue
    }
    if (BINARY.test(entry)) continue
    // The manifest records raw template metadata (answers include the
    // placeholder names by design).
    if (p.endsWith(join('.harness', 'manifest.json'))) continue
    const text = readFileSync(p, 'utf8')
    for (const m of text.matchAll(PLACEHOLDER)) {
      hits.push(`${p.slice(dir.length + 1)}: ${m[0]}`)
    }
  }
})(dir)

if (hits.length > 0) {
  console.error(`RESIDUE: ${hits.length} unrendered placeholder(s):`)
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log('RESIDUE: CLEAN')
