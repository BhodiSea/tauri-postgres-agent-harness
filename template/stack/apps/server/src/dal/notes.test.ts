// DAL DTO-shape tests against a minimal fake of the db context. These always
// run (no DATABASE_URL guard, no skip path — a skipped test must never read as
// green); real cross-tenant isolation runs in tests/rls/ against the compose DB.
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  userIds: [] as string[],
}))

vi.mock('../db/context.js', () => ({
  withUserContext: <T>(userId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    state.userIds.push(userId)
    // A postgres.js transaction handle is a tagged template; the fake ignores the
    // SQL text and returns the canned rows.
    const fakeTx = () => Promise.resolve(state.rows)
    return fn(fakeTx)
  },
}))

const { notesDal } = await import('./notes.js')

// RFC-4122-valid fixtures: NoteDto's uuid validation checks the variant bits.
const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

const validRow = () => ({
  id: NOTE_ID,
  ownerId: USER_ID,
  title: 'zod-parsed at the DAL exit',
  body: '',
  embedding: null,
  sourceModel: null,
  sourceConfidence: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
})

describe('notes DAL returns Zod-parsed DTOs, never raw rows', () => {
  it('list: parses rows into NoteDto shape (Date → JSON-safe ISO-8601 string)', async () => {
    state.rows = [validRow()]
    const notes = await notesDal.list(USER_ID)
    expect(notes).toEqual([
      {
        id: NOTE_ID,
        ownerId: USER_ID,
        title: 'zod-parsed at the DAL exit',
        body: '',
        embedding: null,
        sourceModel: null,
        sourceConfidence: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('list: decodes a pgvector text value into number[]', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.25)
    state.rows = [{ ...validRow(), embedding: JSON.stringify(embedding) }]
    const notes = await notesDal.list(USER_ID)
    expect(notes[0]?.embedding).toEqual(embedding)
  })

  it('list: runs inside withUserContext with the caller identity', async () => {
    state.rows = []
    state.userIds = []
    await notesDal.list(USER_ID)
    expect(state.userIds).toEqual([USER_ID])
  })

  it('list: rejects malformed rows instead of passing them through', async () => {
    state.rows = [{ ...validRow(), id: 'not-a-uuid' }]
    await expect(notesDal.list(USER_ID)).rejects.toThrow()
  })

  it('create: returns the parsed created note (body defaults to empty)', async () => {
    state.rows = [validRow()]
    const note = await notesDal.create(USER_ID, { title: 'zod-parsed at the DAL exit' })
    expect(note.id).toBe(NOTE_ID)
    expect(note.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('create: throws loudly when the insert returns no row', async () => {
    state.rows = []
    await expect(notesDal.create(USER_ID, { title: 'missing returning row' })).rejects.toThrow(
      /returned no row/,
    )
  })

  it('get: returns null when RLS yields no visible row', async () => {
    state.rows = []
    await expect(notesDal.get(USER_ID, NOTE_ID)).resolves.toBeNull()
  })

  it('remove: reports whether a row was deleted', async () => {
    state.rows = [{ id: NOTE_ID }]
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(true)
    state.rows = []
    await expect(notesDal.remove(USER_ID, NOTE_ID)).resolves.toBe(false)
  })
})
