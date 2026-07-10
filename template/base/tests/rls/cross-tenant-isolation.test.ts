// Cross-user isolation over plain Postgres FORCE RLS: as user A, user B's rows must
// be invisible to SELECT, untouchable by UPDATE/DELETE (0 rows matched, no error),
// and un-smugglable via INSERT (WITH CHECK → SQLSTATE 42501). Includes the seeded
// positive control (A sees its own row — a deny-all database must NOT pass), the
// pooled-connection GUC-leak detector, and the catalog gate (FORCE RLS + per-op
// policies + pgvector version straight from pg_catalog).
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: postgres/rls-force]
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  USER_A,
  USER_B,
  appSql,
  withUser,
  type Sql,
} from './db-context'

if (!RLS_SUITE_READY) {
  describe.skip('user-scoped isolation (skipped: database not ready)', () => {
    it('database not ready — RLS suite self-skips (run node tests/rls/run-rls.mjs; FAILS CLOSED in CI)', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('user-scoped isolation', () => {
    let sql: Sql

    beforeAll(async () => {
      sql = appSql()
      // Seed one row per user per target THROUGH the RLS path (impersonated
      // insert) — proving inserts-as-self work is itself part of the contract.
      for (const t of ISOLATION_TARGETS) {
        for (const user of [USER_A, USER_B]) {
          await withUser(sql, user, async (tx) => {
            await tx`INSERT INTO ${tx(t.table)} ${tx(t.seedRow(user))}`
          })
        }
      }
    })

    afterAll(async () => {
      for (const t of ISOLATION_TARGETS) {
        for (const user of [USER_A, USER_B]) {
          await withUser(sql, user, async (tx) => {
            await tx`DELETE FROM ${tx(t.table)}`
          })
        }
      }
      await sql.end({ timeout: 5 })
    })

    it.each(ISOLATION_TARGETS)('isolates user B rows in $table from user A', async (t) => {
      // POSITIVE CONTROL: A sees its OWN row. Without this, a deny-all database
      // would make every assertion below pass vacuously.
      const own = await withUser(sql, USER_A, (tx) =>
        tx`SELECT * FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_A}`,
      )
      expect(own.length).toBeGreaterThanOrEqual(1)

      // SELECT another user's rows → RLS hides them: no error, zero rows.
      const read = await withUser(sql, USER_A, (tx) =>
        tx`SELECT * FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(read).toHaveLength(0)

      // UPDATE / DELETE across users: statements match nothing (0 rows), no error.
      const updated = await withUser(sql, USER_A, (tx) =>
        tx`UPDATE ${tx(t.table)} SET title = 'pwned' WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(updated.count).toBe(0)
      const deleted = await withUser(sql, USER_A, (tx) =>
        tx`DELETE FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(deleted.count).toBe(0)

      // INSERT smuggling B's id must be rejected by WITH CHECK → SQLSTATE 42501.
      await expect(
        withUser(sql, USER_A, (tx) => tx`INSERT INTO ${tx(t.table)} ${tx(t.seedRow(USER_B))}`),
      ).rejects.toMatchObject({ code: '42501' })

      // B still sees B's data untouched (title not 'pwned', row count intact).
      const bOwn = await withUser(sql, USER_B, (tx) =>
        tx`SELECT title FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(bOwn.length).toBeGreaterThanOrEqual(1)
      for (const row of bOwn) expect(row['title']).not.toBe('pwned')
    })

    it('does not leak identity across the pooled connection (GUC hygiene)', async () => {
      // withUser sets the GUC transaction-locally; after the transaction the SAME
      // physical connection (pool max=1) must have no identity: current_setting
      // returns NULL and RLS matches nothing.
      await withUser(sql, USER_A, (tx) => tx`SELECT 1`)
      const guc = await sql`SELECT current_setting('app.user_id', true) AS v`
      expect(guc[0]?.['v'] ?? null).toBeNull()
      for (const t of ISOLATION_TARGETS) {
        const rows = await sql`SELECT * FROM ${sql(t.table)}`
        expect(rows).toHaveLength(0)
      }
    })
  })

  describe('catalog gate (pg_catalog facts, not vibes)', () => {
    let sql: Sql
    beforeAll(() => {
      sql = appSql()
    })
    afterAll(async () => {
      await sql.end({ timeout: 5 })
    })

    it('every isolation target has ENABLE + FORCE row security and per-op policies', async () => {
      for (const t of ISOLATION_TARGETS) {
        const rel = await sql`
          SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = ${`public.${t.table}`}::regclass`
        expect(rel[0], t.table).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        })
        const policies = await sql`
          SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${t.table}`
        const cmds = new Set(policies.map((p) => String(p['cmd'])))
        const covered = (op: string) => cmds.has(op) || cmds.has('ALL')
        for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(covered(op), `${t.table}: policy FOR ${op}`).toBe(true)
        }
      }
    })

    it('pgvector is installed at a patched version (>= 0.8.2)', async () => {
      const ext = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
      expect(ext, 'vector extension installed').toHaveLength(1)
      const [maj = 0, min = 0, pat = 0] = String(ext[0]?.['extversion'])
        .split('.')
        .map(Number)
      // SOURCE: patched pgvector floor per security advisory [corpus: pgvector/hnsw]
      expect(maj * 10000 + min * 100 + pat).toBeGreaterThanOrEqual(802)
    })

    it('the app role is not policy-exempt (no BYPASSRLS, not superuser)', async () => {
      const role = await sql`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
    })
  })
}
