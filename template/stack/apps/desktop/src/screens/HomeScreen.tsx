import { useEffect, useState } from 'react'
import { NotesPanel } from '../features/notes/NotesPanel'
import { useI18n } from '../i18n'
import { commands as ipc, isTauri } from '../ipc'
import { cn } from '../lib/utils'

// The home route's content — the shell's original <main> body, now a screen the
// router mounts for '/'. Owns the host-version probe (a home-screen concern) and
// the reference notes panel.
export function HomeScreen() {
  const { t } = useI18n()
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
        <h2 className="text-base font-medium">{t('home.title')}</h2>
        <p className="mt-2 text-sm text-ink-muted">{t('home.body')}</p>
        {/* The host line stays a null-check on hostVersion, not on a formatted string: the
            two branches are different SENTENCES, not one sentence with a hole, so each is
            its own key rather than a template a translator would have to reassemble. */}
        <p className={cn('mt-4 text-xs', hostVersion === null ? 'text-ink-muted' : 'text-accent')}>
          {hostVersion === null ? t('home.noHost') : t('home.host', { version: hostVersion })}
        </p>
      </section>
      {/* The reference loading/empty/error surface — its test ids come from the
          src/routes.ts manifest entry for this screen. */}
      <NotesPanel />
    </div>
  )
}
