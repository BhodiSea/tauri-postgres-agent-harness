# Module: gate-styleguide

Keeps the design system a living source of truth instead of a slide deck. Three
deterministic checks over the Tailwind v4 CSS-first theme
(`apps/desktop/src/styles.css`):

1. **Token closure** — the `@theme` `--color-*` set and
   `tools/styleguide.manifest.json` must match in both directions.
2. **OKLCH-only** — every color token is an `oklch()` value, so the WCAG contrast
   table documented in `styles.css` stays recomputable and lightness steps stay
   perceptually uniform.
3. **Accent budget** — usages of accent utilities (`text-accent`, `bg-accent`, …)
   across `apps/desktop/src` must stay ≤ the documented budget. The
   near-monochrome + one-accent design dies by a thousand highlights; the budget
   makes each new highlight a reviewed decision.

## What it adds

| File | Purpose |
| --- | --- |
| `tools/check-styleguide-manifest.mjs` | the gate script |
| `tools/styleguide.manifest.json` | documented tokens, accent tokens, and the usage budget — reviewable data |

## Prerequisites

None — the scaffold's `styles.css` already passes (6 oklch tokens, 2 accent
usages against a budget of 10).

## How enabling works

```
npx tauri-postgres-agent-harness enable gate-styleguide
```

then — the one extra step for gate modules — **uncomment the line in
`tools/harness.config.mjs`:**

```js
// ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
```

That file is harness-protected: a human sets `HARNESS_ALLOW_SELF_EDIT=1` or edits
outside an agent session (the installer prints this hint on enable). From then on
the gate runs in `pnpm validate`, the Stop hook, and CI.

## How this gate can FAIL (anti-vacuity)

- Add `--color-danger: #ff0000;` to `@theme` → TWO failures: not oklch, and not in
  the manifest.
- Delete `"edge"` from the manifest's tokens → fails "exists in @theme but is not
  documented".
- Set `"accentUsageBudget": 1` → fails listing every file and count (the scaffold
  uses accent twice). Restore afterwards.
- Delete the `@theme` block → hard fail "token source of truth is gone", never a
  silent pass.

## Notes

- Grows with you: when you add semantic tokens (`--color-warn`, `--color-ok`),
  document them in the manifest in the SAME commit — that is the intended
  friction.
- The sibling idea of a rendered `/styleguide` screen still applies: build one
  from the manifest data, and every documented token is also a visible, reviewed
  swatch.
