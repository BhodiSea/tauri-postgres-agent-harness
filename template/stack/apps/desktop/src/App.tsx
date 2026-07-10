import { useEffect, useState } from 'react'
import { ConnectionStatus } from './features/connection/ConnectionStatus'
import { commands, isTauri } from './ipc'
import { SHORTCUTS } from './keyboard/registry'
import { cn } from './lib/utils'

const APP_NAME = '{{PROJECT_NAME}}'

export function App() {
  const [hostVersion, setHostVersion] = useState<string | null>(null)

  useEffect(() => {
    // Outside the Tauri host (plain-browser `vite dev`, jsdom tests) the IPC
    // bridge is absent; that is a supported mode, not an error.
    if (!isTauri()) return undefined
    let cancelled = false
    commands
      .appVersion()
      .then((version) => {
        if (!cancelled) setHostVersion(version)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-edge px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide">{APP_NAME}</h1>
        <ConnectionStatus />
      </header>

      <main className="flex flex-1 items-center justify-center p-8">
        <section className="w-full max-w-md rounded-lg border border-edge bg-surface p-6">
          <h2 className="text-base font-medium">Ready to build</h2>
          <p className="mt-2 text-sm text-ink-muted">
            This shell wires the stack end to end: typed IPC bindings, the API health probe, and a
            WCAG-safe keyboard-shortcut registry. Replace this card with your first screen.
          </p>
          <p
            className={cn('mt-4 text-xs', hostVersion === null ? 'text-ink-muted' : 'text-accent')}
          >
            {hostVersion === null ? 'Running outside the Tauri host' : `Tauri host v${hostVersion}`}
          </p>
        </section>
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
    </div>
  )
}
