// The canonical route manifest. EVERY user-reachable screen registers here: a
// stable id, the catalog KEY its label lives under, how the SPA reaches it, the
// feature directories it renders, and the data-testid each canonical data state
// (loading/empty/error) exposes. The route-manifest gate
// (tools/check-route-manifest.mjs) closes the
// loop — a directory under src/features/ that no entry references (and that is
// not allowlisted in tools/route-allowlist.json) fails validate — and the e2e
// suites (e2e/states.spec.ts, e2e/a11y.spec.ts's focus walk, e2e/reflow.spec.ts)
// ITERATE this array, so a screen missing an entry is a screen that ships untested,
// and a screen WITH an entry is automatically held to the state-quality, per-route
// focus-visibility, and minimum-window reflow bars the day it registers.
//
// The label is a MESSAGE KEY, not prose: a route's name is the most visible copy in
// the app (nav link, palette entry) and it is translatable like everything else —
// callers render it with `t(route.labelKey)`, so adding a locale renames every route
// with no change here.

import type { MessageKey } from './i18n'

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
  /** Catalog key for the human label shown in nav links, palette entries and failure
   *  output. A KEY, not prose — resolve it with `t(route.labelKey)`. */
  readonly labelKey: MessageKey
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
    labelKey: 'route.home',
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
    labelKey: 'route.matrix',
    path: '/matrix',
    features: ['matrix'],
    states: {
      loading: 'matrix-loading',
      empty: 'matrix-empty',
      error: 'matrix-error',
    },
  },
] as const satisfies readonly RouteEntry[]
