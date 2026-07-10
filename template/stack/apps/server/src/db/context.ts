import postgres from 'postgres'

let client: postgres.Sql | undefined

// Lazy so that importing the app (tests, OpenAPI emission) never requires a
// database. The connection string must be the app_api role — NOT the migrator:
// app_api is subject to FORCE ROW LEVEL SECURITY on every table.
function getDb(): postgres.Sql {
  if (client === undefined) {
    const url = process.env['DATABASE_URL']
    if (url === undefined || url === '') {
      throw new Error(
        'DATABASE_URL is not set — run `pnpm db:up`, apply migrations, and export the app_api connection string',
      )
    }
    client = postgres(url)
  }
  return client
}

/**
 * Every DAL function runs inside this wrapper (BUILD-SPEC DAL law): it opens a
 * transaction and binds the caller's identity to it, which is what the RLS
 * policies key on. There is deliberately no code path that talks to the
 * database outside a user context.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await getDb().begin(async (tx) => {
    // set_config(..., true) is transaction-local (SET LOCAL) — the RLS identity
    // GUC can never leak across pooled connections; policies read
    // (select current_setting('app.user_id', true)::uuid) once per statement.
    // SOURCE: postgres GUC discipline [corpus: postgres/guc-set-local]
    await tx`select set_config('app.user_id', ${userId}, true)`
    return fn(tx)
  })
  return result as T
}

/** Graceful-shutdown hook used by src/index.ts. Safe to call when never connected. */
export async function closeDb(): Promise<void> {
  if (client !== undefined) {
    const closing = client
    client = undefined
    await closing.end({ timeout: 5 })
  }
}
