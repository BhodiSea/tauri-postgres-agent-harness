// The canonical route manifest. EVERY user-reachable screen registers here: a
// stable id, a human label, how the SPA reaches it, the feature directories it
// renders, and the data-testid each canonical data state (loading/empty/error)
// exposes. The route-manifest gate (tools/check-route-manifest.mjs) closes the
// loop — a directory under src/features/ that no entry references (and that is
// not allowlisted in tools/route-allowlist.json) fails validate — and the e2e
// suites (e2e/states.spec.ts, e2e/a11y.spec.ts's focus walk, e2e/reflow.spec.ts)
// ITERATE this array, so a screen missing an entry is a screen that ships untested,
// and a screen WITH an entry is automatically held to the state-quality, per-route
// focus-visibility, and minimum-window reflow bars the day it registers.

interface RouteStates {
  /** data-testid visible while the screen's primary query is in flight. */
  readonly loading: string
  /** data-testid visible when the query resolves to zero items. */
  readonly empty: string
  /** data-testid visible when the query fails — must CONTAIN a retry button. */
  readonly error: string
}

interface RouteEntry {
  /** Stable machine id — lowercase, used in test titles and state test ids. */
  readonly id: string
  /** Human-readable label for palette entries and failure output. */
  readonly label: string
  /** How to reach the screen in the SPA: history path relative to the app origin. */
  readonly path: string
  /** Directories under src/features/ this screen renders (closure-checked). */
  readonly features: readonly string[]
  readonly states: RouteStates
}

// `as const satisfies`: entries stay literal-typed (states.loading is a string
// literal usable directly as a data-testid) while the shape is still checked.
export const ROUTES = [
  {
    id: 'home',
    label: 'Home',
    path: '/',
    features: ['notes'],
    states: {
      loading: 'home-loading',
      empty: 'home-empty',
      error: 'home-error',
    },
  },
  {
    id: 'matrix',
    label: 'Matrix',
    path: '/matrix',
    features: ['matrix'],
    states: {
      loading: 'matrix-loading',
      empty: 'matrix-empty',
      error: 'matrix-error',
    },
  },
] as const satisfies readonly RouteEntry[]
