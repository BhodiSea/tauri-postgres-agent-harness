// DAL DTO-shape tests against a drizzle pg-proxy stand-in for the db context.
// These always run (no DATABASE_URL guard, no skip path — a skipped test must
// never read as green); real cross-tenant isolation runs in tests/rls/ against
// the compose DB. The proxy sits at the DAL's real SQL boundary: every
// statement drizzle emits lands in the callback with its parameters.
import { notes } from '@app/schema'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { describe, expect, it, vi } from 'vitest'
import type { UserTx } from '../db/context.js'
import { decodeNotesCursor } from './cursor.js'

const state = vi.hoisted(() => ({
  queries: [] as { sql: string; params: unknown[] }[],
  rows: [] as unknown[][],
  userIds: [] as string[],
}))

// The pg-proxy driver hands back rows in array mode, ordered like the select
// list — which for select().from(notes) is the table's column definition order.
const COLUMNS = Object.keys(getTableColumns(notes))
const proxyDb = drizzle((sql, params) => {
  state.queries.push({ sql, params })
  return Promise.resolve({ rows: state.rows })
})

vi.mock('../db/context.js', () => ({
  withUserContext: <T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> => {
    state.userIds.push(userId)
    return fn(proxyDb as unknown as UserTx)
  },
}))

const { notesDal } = await import('./notes.js')

// RFC-4122-valid fixtures: NoteDto's uuid validation checks the variant bits.
const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

// createdAt uses the Postgres text form at full microsecond precision — the
// DAL must pass it through VERBATIM (a Date round-trip would truncate to
// milliseconds and corrupt keyset cursors).
const validRow = () => ({
  body: '',
  createdAt: '2026-01-01 00:00:00.123456+00',
  embedding: null,
  id: NOTE_ID,
  ownerId: USER_ID,
  sourceConfidence: null,
  sourceModel: null,
  title: 'zod-parsed at the DAL exit',
})

const asDriverRow = (row: Record<string, unknown>) => COLUMNS.map((column) => row[column])

const reset = (rows: Record<string, unknown>[]) => {
  state.rows = rows.map(asDriverRow)
  state.queries = []
  state.userIds = []
}

describe('notes DAL returns Zod-parsed DTOs, never raw rows', () => {
  it('list: parses rows into the NotesPage shape (timestamptz text kept verbatim)', async () => {
    reset([validRow()])
    const page = await notesDal.list(USER_ID, { limit: 50 })
    expect(page).toEqual({
      items: [
        {
          id: NOTE_ID,
          ownerId: USER_ID,
          title: 'zod-parsed at the DAL exit',
          body: '',
          embedding: null,
          sourceModel: null,
          sourceConfidence: null,
          createdAt: '2026-01-01 00:00:00.123456+00',
        },
      ],
      nextCursor: null,
    })
  })

  it('list: decodes a pgvector text value into number[]', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.25)
    reset([{ ...validRow(), embedding: JSON.stringify(embedding) }])
    const page = await notesDal.list(USER_ID, { limit: 50 })
    expect(page.items[0]?.embedding).toEqual(embedding)
  })

  it('list: runs inside withUserContext with the caller identity', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 50 })
    expect(state.userIds).toEqual([USER_ID])
  })

  it('list: rejects malformed rows instead of passing them through', async () => {
    reset([{ ...validRow(), id: 'not-a-uuid' }])
    await expect(notesDal.list(USER_ID, { limit: 50 })).rejects.toThrow()
  })

  it('list: always issues a bounded SELECT — LIMIT present even without a cursor', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 50 })
    expect(state.queries).toHaveLength(1)
    expect(state.queries[0]?.sql).toMatch(/limit \$\d+$/)
    // limit+1: one sentinel row past the page is the has-more probe.
    expect(state.queries[0]?.params).toContain(51)
  })

  it('list: clamps a hostile limit to the contract max before it reaches SQL', async () => {
    reset([])
    await notesDal.list(USER_ID, { limit: 10_000 })
    expect(state.queries[0]?.params).toContain(201)
  })

  it('list: emits nextCursor only when a sentinel row proves another page exists', async () => {
    const older = {
      ...validRow(),
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      createdAt: '2025-12-31 23:59:59.999999+00',
    }
    const sentinel = {
      ...validRow(),
      id: '550e8400-e29b-41d4-a716-446655440000',
      createdAt: '2025-12-30 00:00:00+00',
    }
    reset([validRow(), older, sentinel])
    const page = await notesDal.list(USER_ID, { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).not.toBeNull()
    // The cursor is the keyset of the LAST RETURNED item — decode round-trips it.
    expect(decodeNotesCursor(page.nextCursor ?? '')).toEqual({
      createdAt: older.createdAt,
      id: older.id,
    })
  })

  it('list: threads the decoded cursor into a keyset row comparison, never OFFSET', async () => {
    reset([])
    const cursor = { createdAt: '2026-01-01 00:00:00.123456+00', id: NOTE_ID }
    await notesDal.list(USER_ID, { limit: 50, cursor })
    const query = state.queries[0]
    expect(query?.sql).toContain('("notes"."created_at", "notes"."id") < ')
    expect(query?.sql).not.toMatch(/offset/i)
    expect(query?.params).toContain(cursor.createdAt)
    expect(query?.params).toContain(cursor.id)
  })

  it('create: returns the parsed created note (body defaults to empty)', async () => {
    reset([validRow()])
    const note = await notesDal.create(USER_ID, { title: 'zod-parsed at the DAL exit' })
    expect(note.id).toBe(NOTE_ID)
    expect(note.createdAt).toBe('2026-01-01 00:00:00.123456+00')
  })

  it('create: throws loudly when the insert returns no row', async () => {
    reset([])
    await expect(notesDal.create(USER_ID, { title: 'missing returning row' })).rejects.toThrow(
      /returned no row/,
    )
  })

  it('get: returns null when RLS yields no visible row', async () => {
    reset([])
    await expect(notesDal.get(USER_ID, NOTE_ID)).resolves.toBeNull()
  })

  it('remove: reports whether a row was deleted', async () => {
    // delete().returning({ id }) selects a single column — single-element rows.
    state.rows = [[NOTE_ID]]
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(true)
    state.rows = []
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(false)
  })
})
