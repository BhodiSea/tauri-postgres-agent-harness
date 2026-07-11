import { useEffect, useState } from 'react'
import { NotesPanel } from '../features/notes/NotesPanel'
import { commands as ipc, isTauri } from '../ipc'
import { cn } from '../lib/utils'

// The home route's content — the shell's original <main> body, now a screen the
// router mounts for '/'. Owns the host-version probe (a home-screen concern) and
// the reference notes panel.
export function HomeScreen() {
  const [hostVersion, setHostVersion] = useState<string | null>(null)

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

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <section className="w-full max-w-md rounded-lg border border-edge bg-surface p-6">
        <h2 className="text-base font-medium">Ready to build</h2>
        <p className="mt-2 text-sm text-ink-muted">
          This shell wires the stack end to end: typed IPC bindings, the API health probe, a command
          palette, and a WCAG-safe keyboard-shortcut registry. Replace this card with your first
          screen.
        </p>
        <p className={cn('mt-4 text-xs', hostVersion === null ? 'text-ink-muted' : 'text-accent')}>
          {hostVersion === null ? 'Running outside the Tauri host' : `Tauri host v${hostVersion}`}
        </p>
      </section>
      {/* The reference loading/empty/error surface — its test ids come from the
          src/routes.ts manifest entry for this screen. */}
      <NotesPanel />
    </div>
  )
}
