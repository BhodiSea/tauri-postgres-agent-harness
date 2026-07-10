#!/usr/bin/env node
// Gate: schema-rls — every Drizzle pgTable is covered by FORCE ROW LEVEL SECURITY and
// per-operation policies in the migration SQL, or is explicitly exempted in
// tools/rls-exempt.json (a write-guard-protected, human-reviewed list with reasons).
// Static and <100ms: it cross-references schema source against migration SQL so a new
// table cannot land without its RLS story. The runtime isolation suite (pnpm test:rls)
// proves the policies actually isolate; this gate proves they exist.
// SOURCE: docs/harness/README.md (schema-rls gate) [corpus: postgres/rls-force]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'schema-rls'
const SCHEMA_DIR = 'packages/schema/src'
const MIGRATIONS_DIR = 'packages/schema/drizzle'
const EXEMPT = 'tools/rls-exempt.json'

if (!existsSync(SCHEMA_DIR)) skipOrFail(GATE, `${SCHEMA_DIR} not found (no schema surface yet)`)

// 1. Collect declared tables from Drizzle schema source: pgTable('name', ...)
const tables = new Set()
;(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/pgTable\(\s*['"]([a-z0-9_]+)['"]/g)) tables.add(m[1])
    }
  }
})(SCHEMA_DIR)

if (tables.size === 0) skipOrFail(GATE, 'no pgTable declarations found yet')

// 2. Collect RLS facts from every migration file (cumulative — later migrations may
//    cover tables created earlier).
let sql = ''
if (existsSync(MIGRATIONS_DIR)) {
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sql += `\n${readFileSync(join(MIGRATIONS_DIR, f), 'utf8')}`
  }
}
const norm = sql.replace(/"/g, '').replace(/\s+/g, ' ')

let exempt = {}
if (existsSync(EXEMPT)) {
  const parsed = JSON.parse(readFileSync(EXEMPT, 'utf8'))
  exempt = parsed.tables ?? parsed
}

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const errs = []
for (const table of tables) {
  if (table in exempt) continue
  const t = `(?:public\\.)?${table}`
  if (!new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`, 'i').test(norm)) {
    errs.push(`${table}: no ENABLE ROW LEVEL SECURITY in any migration`)
  }
  if (!new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`, 'i').test(norm)) {
    errs.push(`${table}: no FORCE ROW LEVEL SECURITY (owner would bypass policies)`)
  }
  const hasAll =
    new RegExp(`CREATE POLICY [a-z0-9_]+ ON ${t}(?! FOR)`, 'i').test(norm) ||
    new RegExp(`CREATE POLICY [a-z0-9_]+ ON ${t} FOR ALL`, 'i').test(norm)
  for (const op of OPS) {
    if (hasAll) break
    if (!new RegExp(`CREATE POLICY [a-z0-9_]+ ON ${t}[^;]* FOR ${op}`, 'i').test(norm)) {
      errs.push(`${table}: no policy FOR ${op} (per-operation policies required)`)
    }
  }
}

failures(
  GATE,
  errs,
  `Add the RLS statements to a NEW migration, or (human decision) exempt the table with a reason in ${EXEMPT}.`,
)
ok(GATE, `${tables.size} table(s) covered by FORCE RLS + per-operation policies`)
