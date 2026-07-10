import { readFileSync } from 'node:fs'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { NewNote, Note } from './index.js'
import * as schema from './index.js'
import { ApiError, EMBEDDING_DIM, HealthResponse, NewNoteInput, NoteDto } from './index.js'

const migrationSql = readFileSync(new URL('../drizzle/0000_init.sql', import.meta.url), 'utf8')

const sample: Note = {
  body: '',
  createdAt: '2026-01-01 00:00:00+00',
  embedding: null,
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  ownerId: '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e',
  sourceConfidence: null,
  sourceModel: null,
  title: 'RLS smoke note',
}

describe('EMBEDDING_DIM', () => {
  it('is 1024 and matches the vector column in the committed migration', () => {
    expect(EMBEDDING_DIM).toBe(1024)
    expect(migrationSql).toContain(`"embedding" vector(${String(EMBEDDING_DIM)})`)
  })
})

describe('DTOs', () => {
  it('round-trips a Note through NoteDto', () => {
    expect(NoteDto.parse(sample)).toEqual(sample)
  })

  it('enforces the embedding dimension contract', () => {
    const full: Note = {
      ...sample,
      embedding: Array.from({ length: EMBEDDING_DIM }, () => 0.5),
    }
    expect(NoteDto.parse(full)).toEqual(full)
    expect(() => NoteDto.parse({ ...sample, embedding: [0.1, 0.2] })).toThrow()
  })

  it('accepts client fields only in NewNoteInput and rejects an empty title', () => {
    const input: NewNote = { body: 'world', title: 'hello' }
    expect(NewNoteInput.parse(input)).toEqual(input)
    expect(() => NewNoteInput.parse({ title: '' })).toThrow()
    // owner_id must never be accepted from the wire — it is not part of the shape.
    expect(NewNoteInput.parse({ ownerId: sample.ownerId, title: 'x' })).toEqual({ title: 'x' })
  })

  it('locks the health and error envelope contracts', () => {
    const health = { ok: true, version: '0.1.0' }
    expect(HealthResponse.parse(health)).toEqual(health)
    expect(() => HealthResponse.parse({ ok: false, version: '0.1.0' })).toThrow()
    expect(ApiError.parse({ error: 'version_skew' })).toEqual({ error: 'version_skew' })
  })
})

describe('migration SQL self-check', () => {
  it('ENABLE + FORCE ROW LEVEL SECURITY covers every pgTable exported by the schema', () => {
    const exported: readonly unknown[] = Object.values(schema)
    const tables = exported.filter((value): value is PgTable => is(value, PgTable))
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      const name = getTableName(table)
      expect(migrationSql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
      expect(migrationSql).toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`)
    }
  })

  it('defines all four per-operation owner policies for notes and grants DML to app_api', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(migrationSql).toContain(
        `CREATE POLICY "notes_${op.toLowerCase()}_own" ON "notes" AS PERMISSIVE FOR ${op} TO "app_api"`,
      )
    }
    expect(migrationSql).toContain(
      "(select nullif(current_setting('app.user_id', true), '')::uuid)",
    )
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notes" TO "app_api"',
    )
  })
})
