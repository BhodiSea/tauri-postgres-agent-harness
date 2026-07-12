// Recently-run command ids, most recent first, persisted in localStorage under
// an app-local key (same persistence conventions as src/theme/theme.ts: a
// module-scoped key, try/catch around every storage touch, and a graceful
// in-memory fallback when storage is unavailable). The store is defensive by
// construction: a corrupt or foreign payload READS as empty — it never throws
// and never poisons the palette — and every read re-validates shape, dedupes,
// and re-caps, so no historical payload can overflow the pinned Recents
// section. Ids whose command no longer exists (a stale build, a contextual
// contribution from an unmounted screen) stay in storage but are filtered at
// the render seam in CommandPalette.tsx, where the LIVE command set is known.

const STORAGE_KEY = 'palette.recents'
const MAX_RECENTS = 5

/** Parse an untrusted payload into at most MAX_RECENTS unique string ids. */
function sanitize(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && !ids.includes(entry)) ids.push(entry)
  }
  return ids.slice(0, MAX_RECENTS)
}

/** The persisted recents, newest first. Corrupt JSON or blocked storage → []. */
export function readRecents(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    return sanitize(JSON.parse(raw))
  } catch {
    // Corrupt payload or private-mode storage: reset to empty, never throw.
    return []
  }
}

/**
 * Record a command invocation: the id floats to the front, the list re-caps at
 * MAX_RECENTS, and the result is persisted AND returned so the caller can keep
 * component state in sync without a second read.
 */
export function pushRecent(id: string): readonly string[] {
  const next = [id, ...readRecents().filter((entry) => entry !== id)].slice(0, MAX_RECENTS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Non-persistent storage still gets the in-session recents below.
  }
  return next
}
