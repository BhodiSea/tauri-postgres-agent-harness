#!/usr/bin/env node
// Orchestrator behind `pnpm test:rls`. Flow, each layer independently guarded:
//   1. Resolve DSNs: env DATABASE_URL / MIGRATOR_DATABASE_URL win; otherwise derive
//      passwordless local-dev DSNs from docker-compose.yml (trust auth, local only).
//   2. Probe the database (SELECT 1 as migrator, 3s timeout). Unreachable →
//      SKIP locally (loud), FAIL CLOSED in CI once migrations exist.
//   3. Reachable → fresh-apply all migrations (tests/migrations/migration-apply.mjs),
//      then run the vitest isolation suite with RLS_SUITE_READY=1 so it runs for real.
//   4. The vitest suite ALWAYS runs (self-skips politely when not ready) and its
//      exit code is the gate. Never hangs, never false-greens a real leak.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const migrationsDir = path.join(repoRoot, 'packages', 'schema', 'drizzle')

function deriveDbName() {
  try {
    const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
    const m = compose.match(/POSTGRES_DB:\s*['"]?([A-Za-z0-9_]+)/)
    if (m) return m[1]
  } catch {
    // fall through
  }
  return 'app'
}

const db = deriveDbName()
// Local-dev defaults matching db/init/01-roles.sql: the documented 'postgres'
// password on loopback only — never a real credential shape.
const DATABASE_URL =
  process.env['DATABASE_URL'] || `postgres://app_api:postgres@127.0.0.1:5432/${db}`
const MIGRATOR_DATABASE_URL =
  process.env['MIGRATOR_DATABASE_URL'] || `postgres://app_migrator:postgres@127.0.0.1:5432/${db}`

async function reachable() {
  let postgres
  try {
    postgres = createRequire(path.join(repoRoot, 'apps/server/package.json'))('postgres')
  } catch {
    return false // no install yet — nothing can run anyway
  }
  const sql = postgres(MIGRATOR_DATABASE_URL, { max: 1, connect_timeout: 3 })
  try {
    await sql`SELECT 1`
    return true
  } catch {
    return false
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
}

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL, MIGRATOR_DATABASE_URL, ...extraEnv },
    stdio: 'inherit',
  })
}

const haveMigrations = existsSync(migrationsDir)
const up = await reachable()

// Fail closed in CI: once migrations exist, the runtime job IS expected to provide a
// database (service container), so a skip there would be a false green on the
// headline isolation gate — not a legitimate pre-schema skip.
if (process.env['CI'] && haveMigrations && !up) {
  console.error('[rls] CI with migrations present but Postgres unreachable — failing closed')
  process.exit(1)
}

let ready = '0'
if (haveMigrations && up) {
  console.log(`[rls] Postgres reachable — fresh-applying migrations to ${db}`)
  try {
    run('node', ['tests/migrations/migration-apply.mjs'])
    ready = '1'
  } catch {
    console.error('[rls] migration apply FAILED')
    process.exit(1)
  }
} else {
  console.log(
    `[rls] skipping DB-backed checks (${haveMigrations ? 'database unreachable — pnpm db:up' : 'no migrations yet'}); the vitest suite will self-skip politely. This layer FAILS CLOSED in CI.`,
  )
}

try {
  run('pnpm', ['exec', 'vitest', 'run', 'tests/rls'], { RLS_SUITE_READY: ready })
} catch {
  console.error('[rls] isolation suite FAILED')
  process.exit(1)
}
console.log('[rls] OK')
process.exit(0)
