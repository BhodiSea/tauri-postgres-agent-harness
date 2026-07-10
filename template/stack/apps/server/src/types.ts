// Shared server-side types. Lives in its own module so app.ts, middleware and
// the DAL can share the Hono env + DAL contract without import cycles.
import type { NewNote, Note } from '@app/schema'

/** Hono environment: `userId` is set by the auth middleware for every /api/* request. */
export interface AppEnv {
  Variables: {
    userId: string
  }
}

/**
 * The notes data-access contract. Routes depend on this interface — only
 * src/dal/* may touch the database driver (BUILD-SPEC DAL law), and tests
 * inject fakes through it. All shapes are @app/schema DTO types.
 */
export interface NotesDal {
  list(userId: string): Promise<Note[]>
  create(userId: string, input: NewNote): Promise<Note>
  get(userId: string, id: string): Promise<Note | null>
  remove(userId: string, id: string): Promise<boolean>
}
