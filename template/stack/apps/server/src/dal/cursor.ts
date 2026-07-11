import { z } from 'zod'

// Keyset-cursor codec for the notes list. The cursor is the (created_at, id)
// key of the last row on the page, base64url-encoded JSON — opaque to clients
// (they echo it back verbatim), fully validated on the way in.
// SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158

// createdAt is carried VERBATIM as the driver returned it (Postgres text form,
// microsecond precision). Re-encoding through a JS Date would truncate to
// milliseconds and make the keyset comparison skip rows that share a
// millisecond — precision is the correctness of the cursor.
const CursorKey = z.strictObject({
  createdAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/)
    .max(64)
    // Date.parse accepts both the ISO and the Postgres text form; NaN catches
    // shapes the regex admits but timestamptz would reject (month 13, hour 25).
    .refine((value) => !Number.isNaN(Date.parse(value))),
  id: z.guid(),
})

/** The decoded keyset position: strictly the last row's (createdAt, id). */
export type NoteCursorKey = z.infer<typeof CursorKey>

export function encodeNotesCursor(key: NoteCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/**
 * Strict decode: anything that is not exactly a cursor this server minted
 * (bad base64, bad JSON, extra fields, malformed timestamp/uuid) returns null
 * and the route answers 400 — never a driver-level cast error.
 */
export function decodeNotesCursor(cursor: string): NoteCursorKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return CursorKey.parse(parsed)
  } catch {
    return null
  }
}
