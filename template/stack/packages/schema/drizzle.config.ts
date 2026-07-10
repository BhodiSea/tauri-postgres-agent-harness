import { defineConfig } from 'drizzle-kit'

// SOURCE: harness doctrine — migrations always connect as the dedicated migrator
// role (schema owner); the runtime app_api role has zero DDL rights and stays
// permanently subject to FORCE RLS. Never point this at DATABASE_URL.
// [corpus: harness/doctrine]
const url = process.env['MIGRATOR_DATABASE_URL']
if (url === undefined || url === '') {
  throw new Error(
    'MIGRATOR_DATABASE_URL is not set — drizzle-kit must connect as the migrator role (see env.example).',
  )
}

export default defineConfig({
  dbCredentials: { url },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/index.ts',
  strict: true,
  verbose: true,
})
