// Central keyboard-shortcut registry. Every shortcut in the app MUST be
// declared here — ad-hoc key handlers bypass the WCAG 2.1.4 test below — and
// every declared shortcut MUST have a handler: App.tsx builds a
// Record<ShortcutId, () => void>, so an entry added here without a handler is
// a COMPILE error (tsc gate), not a dead footer hint.
//
// The description is a MESSAGE KEY, not prose. A shortcut's description is copy —
// it is read aloud in the footer hints and the shortcuts overlay — so it lives in
// the catalog with every other string; consumers render `t(shortcut.descriptionKey)`.
// The `keys` combo stays a literal: 'mod+k' is a key IDENTIFIER the matcher parses,
// not something a translator should ever touch.

import type { MessageKey } from '../i18n'

export interface Shortcut {
  readonly id: string
  /** Key combo, lowercase, `+`-joined. `mod` = Ctrl on Windows/Linux, Cmd on macOS. */
  readonly keys: string
  /** Catalog key for the human description — resolve it with `t(shortcut.descriptionKey)`. */
  readonly descriptionKey: MessageKey
  /** 'global' fires anywhere in the app; 'focused' only while its owning widget has focus. */
  readonly scope: 'global' | 'focused'
}

// SOURCE: WCAG 2.1.4 Character Key Shortcuts — a global shortcut must carry a
// real modifier (or be focus-scoped/remappable), otherwise speech-input and
// screen-reader users trigger it accidentally. registry.test.ts iterates this
// array and fails the build on violations. [corpus: wcag/character-key-shortcuts]
export const SHORTCUTS = [
  {
    id: 'command-palette',
    keys: 'mod+k',
    descriptionKey: 'shortcut.command-palette',
    scope: 'global',
  },
  {
    id: 'show-shortcuts',
    keys: 'mod+/',
    descriptionKey: 'shortcut.show-shortcuts',
    scope: 'global',
  },
] as const satisfies readonly Shortcut[]

export type ShortcutId = (typeof SHORTCUTS)[number]['id']
