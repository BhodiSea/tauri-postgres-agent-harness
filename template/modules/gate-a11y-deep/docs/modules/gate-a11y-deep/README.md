# Module: gate-a11y-deep

The full accessibility sweep: axe with the complete WCAG 2.x tag set (2.0/2.1
A+AA + the 2.2 additions) and a strict keyboard-traversal walk — every tab stop
must be visible, labeled, and inside a landmark — across EVERY route in a
committed route manifest. Plus the manual NVDA checklist automation cannot
replace.

## What it adds

| File | Purpose |
| --- | --- |
| `e2e/a11y-routes.ts` | the route manifest — every user-reachable screen registers here |
| `e2e/a11y-deep.spec.ts` | axe full-tag scan + keyboard-traversal walk per route |
| `.github/workflows/a11y-deep.yml` | per-PR (UI paths) + nightly sweep |
| `docs/nvda-checklist.md` | the manual screen-reader release checklist |

## Prerequisites

- The base e2e lane (ships with the scaffold): `playwright.config.ts`,
  `e2e/mock-ipc.ts`, and the `@playwright/test` / `@axe-core/playwright` devDeps.
- Discipline: add a manifest entry per new route. The sweep fails if the manifest
  is EMPTY, but it cannot know about a route you never listed — reviewers own that
  (the fast lane still covers the shell regardless).

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
- Empty the `ROUTES` array → the manifest guard test fails (an empty sweep is a
  vacuous pass, and the gate says so).

## Honest limits

- axe automates ~30–40% of WCAG; announcement quality, reading order, and
  narration need `docs/nvda-checklist.md` against the real WebView2 binary.
- The sweep runs in chromium against `vite dev` (fast, per-PR viable). WebView2
  rendering differences are covered by the `ci-windows-e2e` module's real-binary
  lane.
