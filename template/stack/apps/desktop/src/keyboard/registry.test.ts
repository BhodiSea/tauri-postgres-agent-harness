import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from './registry'
import type { Shortcut } from './registry'

// SOURCE: WCAG 2.1.4 Character Key Shortcuts — if a shortcut uses only a
// letter/punctuation/number/symbol character it must be remappable, disabled,
// or active only on focus. This registry test structurally forbids unmodified
// single-printable-character GLOBAL shortcuts, which keeps the keyboard-first
// AA claim non-vacuous from day one. [corpus: wcag/character-key-shortcuts]

// Shift is deliberately NOT a modifier here: shift+<char> still emits a
// printable character, so it offers no protection for speech-input users.
const MODIFIERS = new Set(['mod', 'ctrl', 'alt', 'meta'])

// Printable ASCII, space excluded — the characters dictation software emits.
const SINGLE_PRINTABLE = /^[!-~]$/

function violatesCharacterKeyRule(shortcut: Shortcut): boolean {
  if (shortcut.scope !== 'global') return false
  const parts = shortcut.keys.toLowerCase().split('+')
  if (parts.some((part) => MODIFIERS.has(part))) return false
  const key = parts.at(-1) ?? ''
  return SINGLE_PRINTABLE.test(key)
}

describe('keyboard registry — WCAG 2.1.4', () => {
  it('registers at least one shortcut (the rule below must not pass vacuously)', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0)
  })

  it('never binds an unmodified single printable character as a global shortcut', () => {
    const offenders = SHORTCUTS.filter(violatesCharacterKeyRule).map((s) => s.id)
    expect(offenders).toEqual([])
  })
})
