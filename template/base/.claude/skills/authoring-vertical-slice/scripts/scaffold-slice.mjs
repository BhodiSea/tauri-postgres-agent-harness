#!/usr/bin/env node
// Scaffolds the empty file skeleton for a vertical slice across the monorepo.
// Usage: node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs <feature>
// Idempotent: writes a file only when it does not already exist. Node built-ins only.
//
// Deliberately does NOT create the migration file: packages/schema/drizzle/*.sql is
// append-only (the write-guard denies edits to any EXISTING migration, even a fresh
// stub), so a scaffolded migration could never be filled in. The migration-rls-author
// composes the complete migration and writes it exactly once as a new file.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

const [, , feature = 'feature'] = process.argv

if (!/^[a-z][a-z0-9-]*$/.test(feature)) {
  process.stderr.write(
    `invalid feature name: ${JSON.stringify(feature)} (expected /^[a-z][a-z0-9-]*$/)\n`,
  )
  process.exit(1)
}

const base = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd()
const pascal = feature
  .split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('')

const files = [
  [
    join(base, 'packages', 'schema', 'src', `${feature}.ts`),
    '// Drizzle schema for this slice: pgTable(...) with four per-operation pgPolicy\n' +
      "// entries (to: pgRole('app_api').existing()) and .enableRLS(); vector columns\n" +
      '// use EMBEDDING_DIM. Re-export from src/index.ts, then write the SQL migration\n' +
      '// ONCE as a new packages/schema/drizzle/NNNN_' +
      feature +
      '.sql (append-only) with\n' +
      '// ENABLE + FORCE RLS, initPlan policies, GRANT to app_api, and a journal entry.\n' +
      '// See references/migration-rls.md.\n',
  ],
  [
    join(base, 'apps', 'server', 'src', 'dal', `${feature}.ts`),
    '// DAL for this slice — the ONLY layer that may touch the database driver.\n' +
      '// Every function body runs inside withUserContext(userId, tx => ...) from\n' +
      "// '../db/context.js' (transaction-local app.user_id — the authorization\n" +
      '// boundary) and returns Zod-parsed DTOs from @app/schema, never raw rows.\n' +
      '// Declare the DAL interface in ../types.ts so routes can take fakes.\n' +
      '// See references/dal-dto.md.\n',
  ],
  [
    join(base, 'apps', 'server', 'src', 'routes', `${feature}.ts`),
    '// @hono/zod-openapi createRoute contracts for this slice, with schemas from\n' +
      '// @app/schema. Paths mount under /api/* (skew + auth middleware cover that\n' +
      '// prefix). Register the handlers from src/app.ts (the composition root), then\n' +
      '// regenerate the committed contract: pnpm openapi:emit.\n' +
      '// See references/dal-dto.md.\n',
  ],
  [
    join(base, 'apps', 'desktop', 'src', 'features', feature, 'index.tsx'),
    `// Desktop feature '${feature}'. Typed fetch via @app/schema contracts; no\n` +
      '// @tauri-apps/* imports here (wrap them in src/ipc/**); declare shortcuts in\n' +
      '// src/keyboard/registry.ts; degrade gracefully when the API is unreachable.\n' +
      '// See references/desktop-feature.md.\n' +
      `export function ${pascal}View() {\n  return null\n}\n`,
  ],
  [
    join(base, 'apps', 'server', 'src', 'dal', `${feature}.test.ts`),
    "import { describe, it } from 'vitest'\n\n" +
      `describe('${feature} DAL', () => {\n` +
      "  it.todo('maps rows to Zod-parsed DTOs and handles the undefined branches')\n" +
      "  it.todo('injects the owner id from the verified subject, never from the wire')\n})\n",
  ],
  [
    join(base, 'apps', 'desktop', 'src', 'features', feature, 'index.test.tsx'),
    "import { describe, it } from 'vitest'\n\n" +
      `describe('${pascal}View', () => {\n` +
      "  it.todo('renders an accessible, keyboard-operable view (unit-dom)')\n})\n",
  ],
]

for (const [path, body] of files) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    console.log('exists, skipped:', path)
    continue
  }
  writeFileSync(path, body)
  console.log('scaffolded:', path)
}

console.log(
  `next: write packages/schema/drizzle/NNNN_${feature}.sql ONCE (append-only) + its meta/_journal.json entry`,
)
console.log('next: add an IsolationTarget to tests/rls/db-context.ts for each user-scoped table')
console.log('next: register the routes in apps/server/src/app.ts, then run: pnpm openapi:emit')
