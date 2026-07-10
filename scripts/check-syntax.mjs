#!/usr/bin/env node
// Syntax-check every shipped JS module (installer + scripts + template),
// including .tmpl-suffixed files (checked via a temp copy), and validate all
// shipped JSON.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname (which yields /D:/… on Windows)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const tmp = mkdtempSync(join(tmpdir(), 'nsah-syntax-'))
let jsCount = 0
let jsonCount = 0

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      walk(p)
      continue
    }
    if (/\.(mjs|js)(\.tmpl)?$/.test(entry)) {
      let target = p
      if (entry.endsWith('.tmpl')) {
        target = join(tmp, `${jsCount}-${entry.replace(/\.tmpl$/, '')}`)
        copyFileSync(p, target)
      }
      try {
        execFileSync('node', ['--check', target], { stdio: 'pipe' })
        jsCount += 1
      } catch (err) {
        failures.push(`${p}: ${String(err.stderr ?? err.message).split('\n')[0]}`)
      }
    } else if (/\.json(\.tmpl)?$/.test(entry) && !/^tsconfig.*\.json$/.test(entry)) {
      // tsconfig*.json is JSONC by convention (TypeScript strips comments/commas)
      try {
        JSON.parse(readFileSync(p, 'utf8'))
        jsonCount += 1
      } catch (err) {
        failures.push(`${p}: invalid JSON — ${err.message}`)
      }
    }
  }
}

for (const dir of ['installer', 'scripts', 'template', 'tests']) walk(join(ROOT, dir))

if (failures.length) {
  console.error(`SYNTAX: FAIL (${failures.length})`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`SYNTAX: CLEAN (${jsCount} js modules, ${jsonCount} json files)`)
