# Desktop feature reference (React 19 SPA in a Tauri 2 webview)

## Where and how

- Feature dir: `apps/desktop/src/features/<feature>/` — components + colocated
  `*.test.tsx` (the `unit-dom` vitest project, jsdom). Compose classes with Tailwind
  CSS 4 utilities and `cn()` from `src/lib/utils`.
- **Styling is tokens-only** (the `styleguide` gate enforces it): the `@theme` in
  `src/styles.css` + `tools/styleguide.manifest.json` are the ENTIRE design
  vocabulary — colors `canvas/surface/edge/ink/ink-muted/accent`, text `xs..2xl`,
  radius `sm/md/lg`, shadow `sm/md`, fonts `sans/mono`, weights
  `normal/medium/semibold/bold`. The default Tailwind palette and scales are
  ERASED: `text-red-500` or `text-7xl` compiles to NOTHING (a silent no-op). Raw
  hex, raw `px`, and inline `style={}` are gate-red; extending the system means
  editing styles.css AND the manifest together in one reviewed diff. Accent
  utilities are budgeted (10 uses) — the single-accent design is a feature.
- Unit tests never touch the network: `src/test-setup.ts` stubs `fetch` with a
  pending-forever promise and runs RTL cleanup after every test. Drive
  loading/empty/error states by stubbing at your hook/fetcher seam per test;
  real HTTP outcomes belong to e2e (`page.route`).
- **Every screen is REGISTERED** in `apps/desktop/src/routes.ts` (`ROUTES`):
  `{ id, label, path, features: [...], states: { loading, empty, error } }` —
  the states are `data-testid`s your UI must render for each state
  (read path: `NotesPanel.tsx` + `useListQuery.ts`; write path:
  `NoteComposer.tsx` + `useCreateNote.ts` — optimistic insert,
  reconcile-or-rollback, envelope-message toasts, locked by `e2e/mutation.spec.ts`;
  `e2e/states.spec.ts` drives every declared state and runs axe on it). A
  `src/features/<dir>` not referenced by any ROUTES entry (or allowlisted with a
  reason in `tools/route-allowlist.json` — human decision) fails the
  `route-manifest` gate; the `e2e` gate then runs the whole browser lane.
  Every screen needs real loading/empty/error surfaces — an error state must
  contain its retry affordance.
- Data access: typed `fetch` against the API using the Zod contracts from
  `@app/schema` — parse every response body (see
  `features/connection/ConnectionStatus.tsx`). The API origin is
  `import.meta.env.VITE_API_ORIGIN` in dev, otherwise the origin pinned in the
  committed CSP (`tauri.conf.json` `connect-src`) at install time. Send the bearer
  token; expect 401 (auth), 409 `version_skew` (update the app), and network failure
  as first-class states.
- React Compiler is on (exact-pinned babel plugin): follow the Rules of React —
  pure components/hooks, no conditional hooks; the eslint react-hooks + compiler
  rules fail the gate on violations. `[corpus: react/compiler]`

## Boundaries (hook-, lint-, depcruise-, and bundle-gate-enforced)

- NEVER import server/database modules (`postgres`, `drizzle-orm`, `@hono/*`,
  `pino`) or anything from `apps/server` — the write-guard denies it, depcruise
  fails it, and the `build` gate greps the emitted bundle for leaked markers.
- `@tauri-apps/*` imports ONLY inside `src/ipc/**` (the committed tauri-specta
  bindings + wrappers) and `src/keyboard/**`. UI code stays platform-agnostic and
  calls IPC through `src/ipc/`.
- No `dangerouslySetInnerHTML` (write-guard denies). No `VITE_`-prefixed
  secret-shaped env names — Vite compiles them into the shipped bundle.
- New `#[tauri::command]`s belong to the Rust host; after adding one, the specta
  export regenerates `src/ipc/bindings.ts` (the `rust-check` gate fails on drift)
  and the `tauri-security-reviewer` must review it.

## Keyboard registry (the WCAG 2.1.4 rule)

Every shortcut is declared in `apps/desktop/src/keyboard/registry.ts`:

```ts
{ id: '<feature>-action', keys: 'mod+…', description: '…', scope: 'global' | 'focused' }
```

`registry.test.ts` iterates `SHORTCUTS` and fails any GLOBAL shortcut bound to an
unmodified single printable character (shift is NOT a modifier — it still emits a
printable char). Never wire an ad-hoc `keydown` handler that bypasses the registry;
it dodges the structural test. `[corpus: wcag/character-key-shortcuts]`

## Connection-aware UI

The desktop app must degrade gracefully when the API is unreachable: the
`ConnectionStatus` probe polls `GET /healthz` and Zod-parses `{ ok, version }`.
Features follow the same doctrine — render a useful offline/degraded state, disable
mutations while degraded, announce transitions via `aria-live`/`role="status"`, and
recover without a restart.

## Accessibility (WCAG 2.2 AA, webview edition)

No browser chrome exists — the app owns focus and navigation:

- View changes move focus to the new view's heading; dialogs trap focus and restore
  it to the invoker; removing the focused element must not drop focus to `<body>`.
- Visible focus indicator everywhere (no `outline: none` without a replacement).
- Semantic landmarks and heading order; every control labelled (icon-only buttons get
  `aria-label`); AA contrast; targets ≥ 24×24 CSS px (2.5.8); full keyboard
  operability. jsx-a11y runs in strict mode on `apps/desktop` — lint failures are
  gate failures.
