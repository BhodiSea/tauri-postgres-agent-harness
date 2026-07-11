import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
// SOURCE: drizzle pgPolicy/pgRole declare RLS in the schema so the schema-rls
// gate can assert every table carries policies [corpus: postgres/rls-force]
import { pgPolicy, pgRole, pgTable, real, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'

/**
 * Single source of truth for the pgvector embedding dimension. The
 * `notes.embedding` column, the DTOs derived below, and the hand-authored
 * migration in ./drizzle are all asserted against this value (schema.test.ts).
 */
export const EMBEDDING_DIM = 1024

// ---------------------------------------------------------------------------
// Wire bounds — every string/number crossing the API boundary carries explicit
// limits. Unbounded wire input is a memory/storage amplification primitive, so
// contracts reject it at the edge instead of trusting callers.
// SOURCE: harness doctrine — contracts are the enforcement surface; no
// unbounded wire input [corpus: harness/doctrine]
// ---------------------------------------------------------------------------

/** Titles are single-line labels; 200 chars covers real titles without inviting body-in-title. */
export const NOTE_TITLE_MAX = 200
/** Bodies are prose, not blobs: 20 000 chars (~4 000 words), well under the 1 MiB HTTP body cap. */
export const NOTE_BODY_MAX = 20_000
/** Model identifiers ("gpt-…", "claude-…", registry paths) fit comfortably in 128 chars. */
export const SOURCE_MODEL_MAX = 128

/**
 * Keyset pagination bounds for GET /api/notes. Defaults follow large public
 * REST APIs (GitHub: per_page default 30, max 100) scaled to this payload
 * size; the max also caps the DAL's LIMIT so no request demands an unbounded scan.
 * SOURCE: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 */
export const NOTES_PAGE_LIMIT_DEFAULT = 50
export const NOTES_PAGE_LIMIT_MAX = 200

/**
 * Page cursors are opaque tokens (base64url JSON of the last row's keyset).
 * 256 chars bounds the token while leaving headroom over the ~120 chars the
 * server actually emits.
 * SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158
 */
export const NOTES_CURSOR_MAX = 256

// timestamptz over the wire: the ISO-8601 or Postgres text form
// ('2026-01-01T00:00:00.000Z' / '2026-01-01 00:00:00.123456+00'). The DAL keeps
// the driver text verbatim (never re-parsed through a millisecond-truncating
// Date) because keyset cursors compare it back against the column.
const timestampText = (schema: z.ZodString) =>
  schema.regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/).max(64)

// Runtime login role the API server connects as. Roles are created by the
// docker-compose init SQL, never by migrations — hence `.existing()`.
const appApi = pgRole('app_api').existing()

// Wrap current_setting() in a scalar sub-select so the planner evaluates it once
// per statement (initPlan) instead of per row. nullif(..., '') maps both
// no-identity shapes (GUC never set -> NULL; pooled session after a SET LOCAL
// tx -> '') to NULL, which never equals an owner_id — "no identity" fails closed
// instead of raising a 22P02 uuid-cast error.
// SOURCE: PostgreSQL row-security guidance [corpus: postgres/rls-initplan]
const ownerIsCurrentUser = (ownerId: AnyPgColumn) =>
  sql`${ownerId} = (select nullif(current_setting('app.user_id', true), '')::uuid)`

/**
 * Demo domain table proving the whole RLS chain (see drizzle/0000_init.sql for
 * the ENABLE + FORCE + GRANT side). `source_model`/`source_confidence` are the
 * ai-provenance example columns.
 */
export const notes = pgTable(
  'notes',
  {
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    sourceConfidence: real('source_confidence'),
    sourceModel: text('source_model'),
    title: text('title').notNull(),
  },
  (table) => [
    // Four per-operation policies (never FOR ALL): each op stays independently
    // auditable and a future widening of one op cannot silently widen the rest.
    // SOURCE: harness doctrine — per-op owner-scoped policies for app_api [corpus: harness/doctrine]
    pgPolicy('notes_select_own', {
      as: 'permissive',
      for: 'select',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — insert guards via WITH CHECK [corpus: harness/doctrine]
    pgPolicy('notes_insert_own', {
      as: 'permissive',
      for: 'insert',
      to: appApi,
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — update guards read AND write rows [corpus: harness/doctrine]
    pgPolicy('notes_update_own', {
      as: 'permissive',
      for: 'update',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — delete scoped by USING [corpus: harness/doctrine]
    pgPolicy('notes_delete_own', {
      as: 'permissive',
      for: 'delete',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
    }),
  ],
).enableRLS()

/** Row shape the DAL returns (drizzle select + Zod parse at the DAL exit). */
export const NoteDto = createSelectSchema(notes, {
  body: (schema) => schema.max(NOTE_BODY_MAX),
  createdAt: (schema) => timestampText(schema),
  sourceConfidence: (schema) => schema.min(0).max(1), // provenance confidence is a probability
  sourceModel: (schema) => schema.max(SOURCE_MODEL_MAX),
  title: (schema) => schema.min(1).max(NOTE_TITLE_MAX),
})
export type Note = z.infer<typeof NoteDto>

/**
 * Client-supplied fields only: `owner_id` is injected by the DAL from the
 * verified token subject and must never be accepted from the wire.
 */
export const NewNoteInput = createInsertSchema(notes, {
  // .optional() restated: a refinement callback replaces the derived schema,
  // including the optionality the column default ('') would have conferred.
  body: (schema) => schema.max(NOTE_BODY_MAX).optional(),
  title: (schema) => schema.min(1).max(NOTE_TITLE_MAX),
}).pick({ body: true, title: true })
export type NewNote = z.infer<typeof NewNoteInput>

/**
 * Query contract for GET /api/notes — keyset pagination, never OFFSET (an
 * offset scan re-reads and re-discards every skipped row; a keyset seek is
 * O(page) regardless of depth).
 * SOURCE: https://use-the-index-luke.com/no-offset
 */
export const NotesListQuery = z.object({
  cursor: z
    .string()
    .min(1)
    .max(NOTES_CURSOR_MAX)
    .regex(/^[A-Za-z0-9_-]+$/) // base64url alphabet — anything else is not our token
    .optional(),
  limit: z.coerce.number().int().min(1).max(NOTES_PAGE_LIMIT_MAX).default(NOTES_PAGE_LIMIT_DEFAULT),
})
export type NotesListQueryInput = z.infer<typeof NotesListQuery>

/** Response contract for GET /api/notes: one page + the cursor for the next. */
export const NotesPage = z.object({
  items: z.array(NoteDto).max(NOTES_PAGE_LIMIT_MAX),
  nextCursor: z.string().min(1).max(NOTES_CURSOR_MAX).nullable(),
})
export type NotesPageDto = z.infer<typeof NotesPage>

/** Contract for GET /healthz — `{ ok: true, version }`, no auth. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string().max(64),
})
export type Health = z.infer<typeof HealthResponse>

/**
 * The single error envelope: EVERY non-2xx JSON body the server emits —
 * validation failures, auth rejections, 404s, version skew, body-limit
 * rejections, and uncaught exceptions — parses against this schema. `code` is
 * the stable machine-readable contract clients switch on; `message` is for
 * humans and logs; `requestId` correlates a client-visible failure with server
 * logs. The nested code/message envelope follows the Microsoft REST API
 * Guidelines error shape (same family as Google's JSON `error.code/message`).
 * SOURCE: https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md
 */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'not_found',
      'payload_too_large',
      'version_skew',
      'internal',
    ]),
    message: z.string().min(1).max(1024),
    requestId: z.guid().optional(),
  }),
})
export type ApiErrorBody = z.infer<typeof ApiError>
export type ApiErrorCode = ApiErrorBody['error']['code']
