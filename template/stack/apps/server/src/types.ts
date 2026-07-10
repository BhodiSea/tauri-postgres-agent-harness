// Shared server-side types. Lives in its own module so app.ts, middleware and
// the DAL can share the Hono env + DAL contract without import cycles.
import type { NoteCreateDto, NoteDto } from '@app/schema'
import type { z } from 'zod'

/** A note as it crosses the HTTP boundary — always Zod-parsed, never a raw driver row. */
export type Note = z.infer<typeof NoteDto>

/** Validated input for creating a note (output type: defaults already applied). */
export type NoteCreate = z.infer<typeof NoteCreateDto>

/** Hono environment: `userId` is set by the auth middleware for every /api/* request. */
export interface AppEnv {
  Variables: {
    userId: string
  }
}

/**
 * The notes data-access contract. Routes depend on this interface — only
 * src/dal/* may touch the database driver (BUILD-SPEC DAL law), and tests
 * inject fakes through it.
 */
export interface NotesDal {
  list(userId: string): Promise<Note[]>
  create(userId: string, input: NoteCreate): Promise<Note>
  get(userId: string, id: string): Promise<Note | null>
  remove(userId: string, id: string): Promise<boolean>
}
