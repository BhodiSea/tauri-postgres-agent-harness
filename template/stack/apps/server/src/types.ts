// Shared server-side types. Lives in its own module so app.ts, middleware and
// the DAL can share the Hono env + DAL contract without import cycles.
import type { NewNote, Note, NotesPageDto } from '@app/schema'
import type { NoteCursorKey } from './dal/cursor.js'

/**
 * Hono environment: `requestId` is minted by the first app-wide middleware for
 * every request (error envelopes echo it); `userId` is set by the auth
 * middleware for every /api/* request.
 */
export interface AppEnv {
  Variables: {
    requestId: string
    userId: string
  }
}

/**
 * The notes data-access contract. Routes depend on this interface — only
 * src/dal/* may touch the database driver (BUILD-SPEC DAL law), and tests
 * inject fakes through it. All shapes are @app/schema DTO types; `page` is one
 * decoded keyset page request (bounded limit + optional decoded cursor).
 */
export interface NotesDal {
  list(
    userId: string,
    page: { readonly limit: number; readonly cursor?: NoteCursorKey | undefined },
  ): Promise<NotesPageDto>
  create(userId: string, input: NewNote): Promise<Note>
  get(userId: string, id: string): Promise<Note | null>
  remove(userId: string, id: string): Promise<boolean>
}
