# NVDA screen-reader checklist (manual pass — gate-a11y-deep module)

Automated axe scans catch roughly a third of WCAG failures; reading order,
announcement quality, and interaction narration need a human with a screen
reader. Run this checklist with **NVDA on Windows against the REAL app binary**
(WebView2 — the engine your users get, not a dev browser) before each release,
and file the results in the release PR.

Setup: install NVDA (free, nvaccess.org) → launch the installed app → NVDA+1 for
input help while you learn the keys. Speech viewer (NVDA menu → Tools) makes
transcript capture easy.

## Per release

- [ ] **App boot**: window title announced; focus lands somewhere sensible (not
      lost, not on a decorative node).
- [ ] **Landmark walk** (`D` / `Shift+D`): banner → main → contentinfo, each
      announced with a meaningful name; nothing important outside landmarks.
- [ ] **Headings** (`H`): hierarchy matches the visual structure; no skipped
      levels used for styling.
- [ ] **Connection status**: with the API stopped, the degraded message is
      announced via the live region WITHOUT stealing focus (aria-live=polite);
      when the API returns, the connected state is announced once — no chatter
      every poll cycle.
- [ ] **Keyboard shortcuts**: every shortcut in `src/keyboard/registry.ts` works
      with NVDA running (NVDA consumes some single-key input — this is exactly
      why the registry bans bare single-character global shortcuts, WCAG 2.1.4).
- [ ] **Forms** (as they land): every control announces name + role + value;
      errors are announced and reachable; required state is conveyed.
- [ ] **Tables/matrix** (as they land): row/column headers announced while
      navigating cells (`Ctrl+Alt+Arrows`); virtualized rows do not silently
      truncate the accessible table.
- [ ] **Focus visibility**: tab through each screen — the focus indicator is
      always visible (WCAG 2.4.11 focus-not-obscured).
- [ ] **No keyboard traps**: every overlay/dialog can be entered AND exited with
      the keyboard alone.

## Recording the result

Add to the release PR:

```
NVDA pass: <date>, NVDA <version>, Windows <version>, app <version>
Findings: <none | list with severity and issue links>
```

A finding that blocks task completion for a keyboard/screen-reader user is a
release blocker — same severity as a data-loss bug.
