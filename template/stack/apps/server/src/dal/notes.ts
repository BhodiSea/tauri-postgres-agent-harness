import { NoteCreateDto, NoteDto } from '@app/schema'
import { withUserContext } from '../db/context.js'
import type { Note, NotesDal } from '../types.js'

// The select list matches the NoteDto contract exactly. The embedding column is
// internal ML state and is never selected — it is not part of the HTTP DTO.
function toNote(row: Record<string, unknown>): Note {
  const createdAt = row['createdAt']
  // Zod-parse at the DAL exit (BUILD-SPEC DAL law): raw driver rows never escape.
  // postgres.js decodes timestamptz as Date; the DTO carries an ISO-8601 string
  // because it must round-trip through HTTP JSON unchanged.
  return NoteDto.parse({
    ...row,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  })
}

export const notesDal: NotesDal = {
  async list(userId) {
    return withUserContext(userId, async (tx) => {
      // SOURCE: visibility is enforced by the notes RLS policies via the app.user_id GUC —
      // the DAL adds no owner_id WHERE clause by design, so a policy regression cannot be
      // masked by application-side filtering [corpus: postgres/rls-initplan]
      const rows = await tx<Record<string, unknown>[]>`
        select id, owner_id as "ownerId", title, body,
               source_model as "sourceModel", source_confidence as "sourceConfidence",
               created_at as "createdAt"
        from notes
        order by created_at desc`
      return rows.map((row) => toNote(row))
    })
  },

  async create(userId, input) {
    const data = NoteCreateDto.parse(input)
    return withUserContext(userId, async (tx) => {
      // owner_id must equal the transaction's app.user_id or the INSERT policy rejects it.
      const rows = await tx<Record<string, unknown>[]>`
        insert into notes (owner_id, title, body)
        values (${userId}, ${data.title}, ${data.body})
        returning id, owner_id as "ownerId", title, body,
                  source_model as "sourceModel", source_confidence as "sourceConfidence",
                  created_at as "createdAt"`
      const row = rows[0]
      if (row === undefined) {
        throw new Error('insert into notes returned no row')
      }
      return toNote(row)
    })
  },

  async get(userId, id) {
    return withUserContext(userId, async (tx) => {
      const rows = await tx<Record<string, unknown>[]>`
        select id, owner_id as "ownerId", title, body,
               source_model as "sourceModel", source_confidence as "sourceConfidence",
               created_at as "createdAt"
        from notes
        where id = ${id}`
      const row = rows[0]
      return row === undefined ? null : toNote(row)
    })
  },

  async remove(userId, id) {
    return withUserContext(userId, async (tx) => {
      const rows = await tx<Record<string, unknown>[]>`
        delete from notes where id = ${id} returning id`
      return rows.length > 0
    })
  },
}
