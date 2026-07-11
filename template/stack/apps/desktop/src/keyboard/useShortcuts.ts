import { useEffect } from 'react'
import { SHORTCUTS, type Shortcut, type ShortcutId } from './registry'

export type ShortcutHandlers = Readonly<Record<ShortcutId, () => void>>

// Widened to the registry's declared interface: the dispatcher is generic over
// any registry content, so the scope guard below stays meaningful even while
// every CURRENT entry happens to be global (literal types would make the
// comparison vacuous and lint-red).
const REGISTERED: readonly Shortcut[] = SHORTCUTS

// One window-level dispatcher for every registry entry — components never
// attach their own key listeners for global combos, so the registry stays the
// single source of truth the WCAG test audits.
function matchesCombo(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+')
  const key = parts[parts.length - 1] ?? ''
  const wantMod = parts.includes('mod')
  const hasMod = event.ctrlKey || event.metaKey
  return (
    event.key.toLowerCase() === key &&
    hasMod === wantMod &&
    event.shiftKey === parts.includes('shift') &&
    event.altKey === parts.includes('alt')
  )
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const shortcut of REGISTERED) {
        if (shortcut.scope !== 'global') continue
        if (matchesCombo(event, shortcut.keys)) {
          event.preventDefault()
          handlers[shortcut.id as ShortcutId]()
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handlers])
}
