// EXPLAIN plan-regression probe: at realistic scale, every RLS-scoped list query must
// reach its table through the owner-column index with identity resolved ONCE per
// statement (initPlan), never per row. The isolation suite proves WHO can see rows;
// this file proves the ACCESS PATH — the classic silent failure is a green isolation
// matrix over 4 rows that ships a sequential scan at 2 million rows.
// Method: bulk-seed PROBE_ROWS rows across PROBE_OWNERS distinct synthetic owners as
// the migrator (RLS WITH CHECK forbids cross-owner seeding via the app role, and
// ANALYZE requires table ownership) with FORCE lifted transactionally — FORCE binds
// the OWNER too, so even the migrator cannot touch foreign rows without it — pin
// statistics with ANALYZE, then run a plain EXPLAIN (FORMAT JSON) — plans only,
// never executes — of the canonical unfiltered list query AS app_api and assert the
// plan shape. Assertions run only through the unprivileged role; the migrator
// connection seeds and cleans, nothing else.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: postgres/rls-initplan]
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appSql,
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  type Sql,
  USER_A,
  withUser,
} from './db-context'

// Planner math the constants must respect: the policy qual `owner = (select ...)` is
// an unknown Param at plan time, estimated at 1/ndistinct selectivity — with only 2
// owners that is 50% and a Seq Scan is the CORRECT plan, so the probe seeds many
// distinct owners (10k rows / 1k owners → ~0.1% estimated → the index wins ~10x on
// cost and dropping it flips the plan to Seq Scan, which is exactly the regression).
// SOURCE: PostgreSQL selectivity estimation for non-constant equality
// (var_eq_non_const uses 1/n_distinct) [corpus: postgres/rls-initplan]
const PROBE_ROWS = 10_000
const PROBE_OWNERS = 1_000
const IDENT = /^[a-z_][a-z0-9_]*$/

// Deterministic synthetic owner for row i of a table: md5 hex is a valid uuid text
// form, so the seed set is reproducible and exactly enumerable for cleanup.
function ownerSeriesExpr(table: string, series: string): string {
  return `md5('${table}:' || (${series})::text)::uuid`
}

// The ONE sanctioned migrator use outside tests/migrations/: bulk-seeding foreign
// owners and ANALYZE both require the table owner. Never copy this into app or
// assertion code — the bash-guard confines this DSN to the harness runners.
function migratorSql(): Sql {
  const url = process.env['MIGRATOR_DATABASE_URL']
  if (!url) throw new Error('MIGRATOR_DATABASE_URL not set (run via node tests/rls/run-rls.mjs)')
  return postgres(url, { max: 1, prepare: false })
}

function scalarParam(table: string, column: string, value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`plan probe: ${table}.${column} seedRow value must be a scalar to bulk-seed`)
}

// FORCE RLS applies to the table owner as well (that is its point — see 0000_init),
// so the migrator's seed/cleanup DML would be denied (INSERT) or silently match zero
// rows (DELETE). Lift FORCE for exactly one transaction: ALTER TABLE is transactional
// and concurrent readers see only committed state, so the catalog checks running in
// the sibling suite can never observe FORCE off.
// SOURCE: PostgreSQL ALTER TABLE — FORCE ROW LEVEL SECURITY binds the owner
// [corpus: postgres/rls-force]
async function withForceLifted(
  migrator: Sql,
  table: string,
  fn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await migrator.begin(async (tx) => {
    await tx.unsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`)
    await fn(tx)
    await tx.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
  })
}

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Parent Relationship'?: string
  Plans?: PlanNode[]
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => flatten(child))]
}

if (!RLS_SUITE_READY) {
  describe.skip('RLS plan regression (skipped: database not ready)', () => {
    it('database not ready — plan probe self-skips (run node tests/rls/run-rls.mjs; FAILS CLOSED in CI)', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('RLS plan regression (EXPLAIN, pinned stats)', () => {
    let sql: Sql
    let migrator: Sql

    beforeAll(async () => {
      sql = appSql()
      migrator = migratorSql()
      for (const t of ISOLATION_TARGETS) {
        const sample = t.seedRow(USER_A)
        const otherCols = Object.keys(sample).filter((c) => c !== t.ownerColumn)
        for (const name of [t.table, t.ownerColumn, ...otherCols]) {
          if (!IDENT.test(name)) throw new Error(`plan probe: suspicious identifier "${name}"`)
        }
        const cols = [t.ownerColumn, ...otherCols].map((c) => `"${c}"`).join(', ')
        const placeholders = otherCols.map((_c, i) => `, $${String(i + 1)}`).join('')
        await withForceLifted(migrator, t.table, async (tx) => {
          await tx.unsafe(
            `INSERT INTO "${t.table}" (${cols})
             SELECT ${ownerSeriesExpr(t.table, `i % ${String(PROBE_OWNERS)}`)}${placeholders}
             FROM generate_series(1, ${String(PROBE_ROWS)}) AS i`,
            otherCols.map((c) => scalarParam(t.table, c, sample[c])),
          )
        })
        // Pinned statistics: the assertions below are about the PLANNER's choice, so
        // the probe never depends on autovacuum timing.
        await migrator.unsafe(`ANALYZE "${t.table}"`)
      }
    }, 60_000)

    afterAll(async () => {
      for (const t of ISOLATION_TARGETS) {
        await withForceLifted(migrator, t.table, async (tx) => {
          await tx.unsafe(
            `DELETE FROM "${t.table}" WHERE "${t.ownerColumn}" IN
               (SELECT ${ownerSeriesExpr(t.table, 'i')}
                FROM generate_series(0, ${String(PROBE_OWNERS - 1)}) AS i)`,
          )
        })
        await migrator.unsafe(`ANALYZE "${t.table}"`)
      }
      await migrator.end({ timeout: 5 })
      await sql.end({ timeout: 5 })
    }, 60_000)

    it.each(
      ISOLATION_TARGETS,
    )('$table: the RLS-scoped list uses the owner index once per statement (no Seq Scan, no per-row SubPlan)', async (t) => {
      const rows = await withUser(sql, USER_A, async (tx) => {
        // jit compiles nothing under plain EXPLAIN but is pinned off anyway so the
        // probe stays byte-comparable if it ever grows an ANALYZE option.
        // SOURCE: deterministic plan-shape testing [corpus: harness/doctrine]
        await tx`SELECT set_config('jit', 'off', true)`
        // Mirrors the DAL list contract: NO owner_id WHERE clause — the policy is
        // the only qual, so this plan is exactly what production list queries get.
        return tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM "${t.table}"`)
      })
      const planJson = (rows[0] as Record<string, unknown> | undefined)?.['QUERY PLAN']
      const root = (planJson as { Plan: PlanNode }[] | undefined)?.[0]?.Plan
      if (root === undefined) throw new Error(`EXPLAIN returned no parseable plan for ${t.table}`)
      const nodes = flatten(root)

      const tableScans = nodes.filter((n) => n['Relation Name'] === t.table)
      expect(
        tableScans.length,
        `${t.table}: some plan node must scan the table`,
      ).toBeGreaterThanOrEqual(1)
      for (const scan of tableScans) {
        expect(
          scan['Node Type'],
          `${t.table}: must be reached through the ${t.ownerColumn} index at ${String(PROBE_ROWS)} rows — a Seq Scan here is the silent 100x RLS regression`,
        ).toMatch(/^(Index Scan|Index Only Scan|Bitmap Heap Scan)$/)
      }
      expect(
        nodes.filter((n) => n['Parent Relationship'] === 'SubPlan'),
        `${t.table}: a correlated SubPlan means the policy re-resolves identity per row — keep the (select current_setting(...)) initPlan shape`,
      ).toHaveLength(0)
      expect(
        nodes.some((n) => n['Parent Relationship'] === 'InitPlan'),
        `${t.table}: the identity sub-select must plan as a once-per-statement InitPlan`,
      ).toBe(true)
    })
  })
}
