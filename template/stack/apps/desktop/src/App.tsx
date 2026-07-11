import { useEffect, useMemo, useState } from 'react'
import { ConnectionStatus, PROBE_CONNECTION_EVENT } from './features/connection/ConnectionStatus'
import { NotesPanel } from './features/notes/NotesPanel'
import { type Command, CommandPalette } from './features/palette/CommandPalette'
import { ShortcutsOverlay } from './features/shortcuts/ShortcutsOverlay'
import { commands as ipc, isTauri } from './ipc'
import { SHORTCUTS, type ShortcutId } from './keyboard/registry'
import { useShortcuts } from './keyboard/useShortcuts'
import { cn } from './lib/utils'

const APP_NAME = '{{PROJECT_NAME}}'

export function App() {
  const [hostVersion, setHostVersion] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  useEffect(() => {
    // Outside the Tauri host (plain-browser `vite dev`, jsdom tests) the IPC
    // bridge is absent; that is a supported mode, not an error.
    if (!isTauri()) return undefined
    let cancelled = false
    ipc
      .appVersion()
      .then((version) => {
        if (!cancelled) setHostVersion(version)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Record<ShortcutId, …>: adding a registry entry without a handler here is a
  // COMPILE error — advertised shortcuts can never be dead UI again.
  const handlers: Record<ShortcutId, () => void> = useMemo(
    () => ({
      'command-palette': () => {
        setPaletteOpen(true)
      },
      'show-shortcuts': () => {
        setShortcutsOpen(true)
      },
    }),
    [],
  )
  useShortcuts(handlers)

  const paletteCommands: readonly Command[] = useMemo(
    () => [
      {
        id: 'shortcuts.show',
        title: 'Show keyboard shortcuts',
        run: () => {
          setShortcutsOpen(true)
        },
      },
      {
        id: 'connection.probe',
        title: 'Probe API connection now',
        run: () => {
          window.dispatchEvent(new Event(PROBE_CONNECTION_EVENT))
        },
      },
    ],
    [],
  )

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-edge px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide">{APP_NAME}</h1>
        <ConnectionStatus />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <section className="w-full max-w-md rounded-lg border border-edge bg-surface p-6">
          <h2 className="text-base font-medium">Ready to build</h2>
          <p className="mt-2 text-sm text-ink-muted">
            This shell wires the stack end to end: typed IPC bindings, the API health probe, a
            command palette, and a WCAG-safe keyboard-shortcut registry. Replace this card with your
            first screen.
          </p>
          <p
            className={cn('mt-4 text-xs', hostVersion === null ? 'text-ink-muted' : 'text-accent')}
          >
            {hostVersion === null ? 'Running outside the Tauri host' : `Tauri host v${hostVersion}`}
          </p>
        </section>
        {/* The reference loading/empty/error surface — its test ids come from the
            src/routes.ts manifest entry for this screen. */}
        <NotesPanel />
      </main>

      <footer className="border-t border-edge px-6 py-2">
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.id} className="flex items-center gap-2">
              <kbd className="rounded border border-edge bg-surface px-1.5 py-0.5 font-mono">
                {shortcut.keys}
              </kbd>
              <span>{shortcut.description}</span>
            </li>
          ))}
        </ul>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false)
        }}
        commands={paletteCommands}
      />
      <ShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => {
          setShortcutsOpen(false)
        }}
      />
    </div>
  )
}
