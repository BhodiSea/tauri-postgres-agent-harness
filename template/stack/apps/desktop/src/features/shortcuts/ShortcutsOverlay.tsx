import { AppDialog } from '../../components/AppDialog'
import { SHORTCUTS } from '../../keyboard/registry'

interface ShortcutsOverlayProps {
  readonly open: boolean
  readonly onClose: () => void
}

// The mod+/ overlay — registry-driven, so a shortcut added to the registry
// appears here (and in the footer hints) without touching this component.
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  return (
    <AppDialog title="Keyboard shortcuts" open={open} onClose={onClose}>
      <ul className="flex flex-col gap-2">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.id} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-ink">{shortcut.description}</span>
            <kbd className="rounded border border-edge bg-canvas px-1.5 py-0.5 font-mono text-xs text-ink-muted">
              {shortcut.keys}
            </kbd>
          </li>
        ))}
      </ul>
    </AppDialog>
  )
}
