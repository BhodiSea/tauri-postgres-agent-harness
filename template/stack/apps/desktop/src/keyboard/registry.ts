// Central keyboard-shortcut registry. Every shortcut in the app MUST be
// declared here — ad-hoc key handlers bypass the WCAG 2.1.4 test below.

export type Shortcut = {
  readonly id: string
  /** Key combo, lowercase, `+`-joined. `mod` = Ctrl on Windows/Linux, Cmd on macOS. */
  readonly keys: string
  readonly description: string
  /** 'global' fires anywhere in the app; 'focused' only while its owning widget has focus. */
  readonly scope: 'global' | 'focused'
}

// SOURCE: WCAG 2.1.4 Character Key Shortcuts — a global shortcut must carry a
// real modifier (or be focus-scoped/remappable), otherwise speech-input and
// screen-reader users trigger it accidentally. registry.test.ts iterates this
// array and fails the build on violations. [corpus: wcag/character-key-shortcuts]
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'command-palette', keys: 'mod+k', description: 'Command palette', scope: 'global' },
  { id: 'new-note', keys: 'mod+n', description: 'New note', scope: 'global' },
  { id: 'show-shortcuts', keys: 'mod+/', description: 'Keyboard shortcuts', scope: 'global' },
]
