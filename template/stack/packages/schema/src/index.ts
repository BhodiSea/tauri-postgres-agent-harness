import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  pgPolicy,
  pgRole,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

/**
 * Single source of truth for the pgvector embedding dimension. The
 * `notes.embedding` column, the DTOs derived below, and the hand-authored
 * migration in ./drizzle are all asserted against this value (schema.test.ts).
 */
export const EMBEDDING_DIM = 1024;

// Runtime login role the API server connects as. Roles are created by the
// docker-compose init SQL, never by migrations — hence `.existing()`.
const appApi = pgRole('app_api').existing();

// SOURCE: PostgreSQL row-security guidance — wrap current_setting() in a scalar
// sub-select so the planner evaluates it once per statement (initPlan) instead of
// per row; missing_ok=true makes an unset app.user_id yield NULL, which can never
// equal an owner_id, so "no identity" fails closed. [corpus: postgres/rls-initplan]
const ownerIsCurrentUser = (ownerId: AnyPgColumn) =>
  sql`${ownerId} = (select current_setting('app.user_id', true)::uuid)`;

/**
 * Demo domain table proving the whole RLS chain (see drizzle/0000_init.sql for
 * the ENABLE + FORCE + GRANT side). `source_model`/`source_confidence` are the
 * ai-provenance example columns.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    sourceModel: text('source_model'),
    sourceConfidence: real('source_confidence'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
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
    pgPolicy('notes_insert_own', {
      as: 'permissive',
      for: 'insert',
      to: appApi,
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    pgPolicy('notes_update_own', {
      as: 'permissive',
      for: 'update',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    pgPolicy('notes_delete_own', {
      as: 'permissive',
      for: 'delete',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
    }),
  ],
).enableRLS();

/** Row shape the DAL returns (drizzle select + Zod parse at the DAL exit). */
export const NoteDto = createSelectSchema(notes);
export type Note = z.infer<typeof NoteDto>;

/**
 * Client-supplied fields only: `owner_id` is injected by the DAL from the
 * verified token subject and must never be accepted from the wire.
 */
export const NewNoteInput = createInsertSchema(notes, {
  title: (schema) => schema.min(1),
}).pick({ title: true, body: true });
export type NewNote = z.infer<typeof NewNoteInput>;

/** Contract for GET /healthz — `{ ok: true, version }`, no auth. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type Health = z.infer<typeof HealthResponse>;

/**
 * Error envelope for JSON error responses. The version-skew middleware answers
 * 409 with `{ error: 'version_skew' }` when the client major mismatches.
 */
export const ApiError = z.object({
  error: z.string(),
});
export type ApiErrorBody = z.infer<typeof ApiError>;
