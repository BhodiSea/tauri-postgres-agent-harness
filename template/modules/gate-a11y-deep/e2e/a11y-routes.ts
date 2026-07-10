// Route manifest for the deep accessibility sweep (gate-a11y-deep module).
// EVERY user-reachable route belongs here — the sweep iterates this array, so a
// screen missing from the manifest is a screen that ships unaudited. Reviewers:
// treat a new route without a manifest entry the way you treat an untested branch.
export interface RouteEntry {
  /** Path relative to baseURL (the vite dev server). */
  readonly path: string
  /** Human-readable name used in test titles and failure output. */
  readonly name: string
}

export const ROUTES: readonly RouteEntry[] = [
  { path: '/', name: 'app shell' },
  // Add each screen as it lands, e.g.:
  // { path: '/settings', name: 'settings' },
  // { path: '/matrix', name: 'matrix view' },
]
