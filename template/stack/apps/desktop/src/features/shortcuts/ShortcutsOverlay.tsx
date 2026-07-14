import { AppDialog } from '../../components/AppDialog'
import { useI18n } from '../../i18n'
import { SHORTCUTS } from '../../keyboard/registry'

interface ShortcutsOverlayProps {
  readonly open: boolean
  readonly onClose: () => void
}

// The mod+/ overlay — registry-driven, so a shortcut added to the registry
// appears here (and in the footer hints) without touching this component. The
// registry carries a `descriptionKey`, not prose: the row's copy is resolved
// against the catalog HERE, at render, so it follows the active locale — a
// description stored as an English string would have pinned this overlay to
// English no matter how the registry grew.
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useI18n()
  return (
    <AppDialog title={t('shortcuts.title')} open={open} onClose={onClose}>
      <ul className="flex flex-col gap-2">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.id} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-ink">{t(shortcut.descriptionKey)}</span>
            <kbd className="rounded border border-edge bg-canvas px-1.5 py-0.5 font-mono text-xs text-ink-muted">
              {shortcut.keys}
            </kbd>
          </li>
        ))}
      </ul>
    </AppDialog>
  )
}
