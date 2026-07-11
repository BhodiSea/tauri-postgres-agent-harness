# Module: gate-a11y-deep

The full accessibility sweep: axe with the complete WCAG 2.x tag set (2.0/2.1
A+AA + the 2.2 additions) and a strict keyboard-traversal walk — every tab stop
must be visible, labeled, and inside a landmark, and the Tab cycle must
TERMINATE (a revisited element before the cycle completes is a focus trap and
fails loudly) — across EVERY route in the canonical manifest
`apps/desktop/src/routes.ts`. Plus the manual NVDA checklist automation cannot
replace.

## What it adds

| File | Purpose |
| --- | --- |
| `e2e/a11y-deep.spec.ts` | axe full-tag scan + keyboard-traversal walk per route |
| `.github/workflows/a11y-deep.yml` | per-PR (UI paths) + nightly sweep |
| `docs/nvda-checklist.md` | the manual screen-reader release checklist |

The route manifest itself ships with the scaffold (`apps/desktop/src/routes.ts`)
and is closure-checked by the default `route-manifest` gate
(`tools/check-route-manifest.mjs`): a feature directory that no ROUTES entry
references (and that is not allowlisted in `tools/route-allowlist.json`) fails
`pnpm validate` — so this sweep can no longer be starved by an unregistered
screen. (The module's former private `e2e/a11y-routes.ts` was retired in favor
of that single manifest.)

## Prerequisites

- The base e2e lane (ships with the scaffold): `playwright.config.ts`,
  `e2e/mock-ipc.ts`, `apps/desktop/src/routes.ts`, and the `@playwright/test` /
  `@axe-core/playwright` devDeps.

## How enabling works

```
npx tauri-postgres-agent-harness enable gate-a11y-deep
```

Files land in the existing `e2e/` directory; the workflow is live immediately.
The workflow IS the gate — no `tools/harness.config.mjs` change. Locally:
`pnpm exec playwright test e2e/a11y-deep.spec.ts`.

## How this gate can FAIL (anti-vacuity)

- Remove the `aria-live` status text — or add `<img>` without `alt` to the shell —
  → axe fails with the rule id and the exact node.
- Add a focusable control OUTSIDE `<header>/<main>/<footer>` → the traversal walk
  fails "must live inside a landmark".
- Add a `tabindex="0"` element with no text/label → fails "must have an
  accessible name".
- Trap focus (a widget whose keydown handler swallows Tab, or an element that
  re-focuses itself) → the walk fails "focus TRAP" / "never completed a cycle"
  instead of silently exhausting its press budget.
- Remove every tabbable element from a route → fails "must expose at least one
  keyboard focus stop" (a keyboard-inoperable page can no longer pass vacuously).
- Empty the `ROUTES` array → the manifest guard test fails here AND the
  `route-manifest` gate fails `pnpm validate`.

## Honest limits

- axe automates ~30–40% of WCAG; announcement quality, reading order, and
  narration need `docs/nvda-checklist.md` against the real WebView2 binary.
- The sweep runs in chromium against `vite dev` (fast, per-PR viable). WebView2
  rendering differences are covered by the `ci-windows-e2e` module's real-binary
  lane.
