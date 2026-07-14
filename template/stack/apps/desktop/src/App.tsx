import { lazy, Suspense, useState } from 'react'
import { Button } from './components/Button'
import { Skeleton } from './components/Skeleton'
import { ToastProvider, useToast } from './components/Toast'
import { ConnectionStatus, PROBE_CONNECTION_EVENT } from './features/connection/ConnectionStatus'
import { type Command, CommandPalette } from './features/palette/CommandPalette'
import { ShortcutsOverlay } from './features/shortcuts/ShortcutsOverlay'
import { LOCALES, useI18n } from './i18n'
import { SHORTCUTS, type ShortcutId } from './keyboard/registry'
import { useShortcuts } from './keyboard/useShortcuts'
import { cn } from './lib/utils'
import { navigate, usePathname } from './router'
import { ROUTES } from './routes'
import { HomeScreen } from './screens/HomeScreen'
import { nextPreference, setThemePreference, useTheme } from './theme/theme'

const APP_NAME = '{{PROJECT_NAME}}'

// Matrix is a lazy route: its data-dense grid (and react-dom-free rendering path)
// stays out of the initial bundle until the user visits '/matrix'.
const MatrixScreen = lazy(() => import('./screens/MatrixScreen'))

// Palette key hints derive from the ONE shortcut registry — a palette command
// that mirrors a shortcut looks its combo up here, so the hint can never drift
// from what the keyboard actually does.
const SHORTCUT_KEYS = Object.fromEntries(
  SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys]),
) as Record<ShortcutId, string>

// The header theme control: cycles system → light → dark → system, names the NEXT
// state for assistive tech, and confirms each switch with a toast (the shell's
// first Toast consumer).
//
// The three catalog families (`theme.*`, `theme.switch.*`, `theme.toast.*`) are keyed
// BY the ThemePreference union, so the label, the accessible name and the toast are all
// one interpolated key each — and the exhaustiveness the old Record<ThemePreference,…>
// map gave us is not lost, it moved into the type: a new preference with no matching
// catalog key is not a MessageKey, so `t()` fails to compile rather than shipping a
// button whose name is the raw key.
function ThemeToggle() {
  const { preference, cycle } = useTheme()
  const { t } = useI18n()
  const toast = useToast()
  const next = nextPreference(preference)
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="theme-toggle"
      aria-label={t(`theme.switch.${next}`)}
      onClick={() => {
        cycle()
        toast.show(t(`theme.toast.${next}`))
      }}
    >
      {t(`theme.${preference}`)}
    </Button>
  )
}

// The language control: cycles the locales this build speaks, names the NEXT one for
// assistive tech, and persists the choice. It is the same ring-cycle shape as ThemeToggle
// rather than a <select>, because a raw select with a className outside src/components is
// gate-red (the styleguide's primitive-boundary scan) and a whole new primitive is not worth
// three options.
function LocaleToggle() {
  const { locale, setLocale, t } = useI18n()
  const next = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] ?? 'en'
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="locale-toggle"
      aria-label={t('locale.switch', { language: t(`locale.${next}`) })}
      onClick={() => {
        setLocale(next)
      }}
    >
      {t(`locale.${locale}`)}
    </Button>
  )
}

function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Contextual palette commands, contributed by the ACTIVE screen: App hands
  // setScreenCommands down as the typed `registerCommands` prop (see
  // RegisterCommands in CommandPalette.tsx); the screen registers on mount and
  // unregisters on unmount — plain props + state, no event bus.
  const [screenCommands, setScreenCommands] = useState<readonly Command[]>([])
  const pathname = usePathname()
  const toast = useToast()
  const { t } = useI18n()

  // Record<ShortcutId, …>: adding a registry entry without a handler here is a
  // COMPILE error — advertised shortcuts can never be dead UI again. (No manual
  // memo: React Compiler stabilizes this object; useShortcuts subscribes once.)
  const handlers: Record<ShortcutId, () => void> = {
    'command-palette': () => {
      setPaletteOpen(true)
    },
    'show-shortcuts': () => {
      setShortcutsOpen(true)
    },
  }
  useShortcuts(handlers)

  // Palette commands: a generated "Go to <label>" per route, the two theme
  // switches, the static shell actions, then whatever the active screen
  // contributed. Registration order is also the empty-query section order;
  // typing re-ranks the flat list (fuzzyScore.ts) and regroups it. React
  // Compiler memoizes the array.
  //
  // Every title/subtitle is a catalog key, and `group` is now a machine ID
  // ('navigation', not 'Navigation') — the palette renders the section header as
  // t(`palette.group.${group}`), so a section name is copy like any other and the
  // union no longer doubles as English. The route command's title nests two lookups:
  // the "Go to {label}" frame and the route's own label, each translated on its own.
  const paletteCommands: readonly Command[] = [
    ...ROUTES.map(
      (route): Command => ({
        id: `nav.${route.id}`,
        title: t('command.goTo', { label: t(route.labelKey) }),
        group: 'navigation',
        subtitle: route.path,
        run: () => {
          navigate(route.path)
        },
      }),
    ),
    {
      id: 'theme.light',
      title: t('command.theme.light'),
      group: 'theme',
      run: () => {
        setThemePreference('light')
        toast.show(t('theme.toast.light'))
      },
    },
    {
      id: 'theme.dark',
      title: t('command.theme.dark'),
      group: 'theme',
      run: () => {
        setThemePreference('dark')
        toast.show(t('theme.toast.dark'))
      },
    },
    {
      id: 'shortcuts.show',
      title: t('command.shortcuts'),
      group: 'view',
      keys: SHORTCUT_KEYS['show-shortcuts'],
      run: () => {
        setShortcutsOpen(true)
      },
    },
    {
      id: 'connection.probe',
      title: t('command.probe'),
      group: 'view',
      // The path, not prose: it names the endpoint the probe hits, so it reads the
      // same in every locale (and the i18n gate exempts path-shaped literals).
      subtitle: '/healthz',
      run: () => {
        window.dispatchEvent(new Event(PROBE_CONNECTION_EVENT))
      },
    },
    ...screenCommands,
  ]

  // Unknown paths fall back to home (ROUTES[0]).
  const active = ROUTES.find((route) => route.path === pathname) ?? ROUTES[0]

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between gap-4 border-b border-edge px-6 py-3">
        <div className="flex items-center gap-6">
          <h1 className="text-sm font-semibold tracking-wide">{APP_NAME}</h1>
          <nav aria-label={t('nav.primary')} className="flex items-center gap-4 text-xs">
            {ROUTES.map((route) => {
              const isActive = route.path === pathname
              return (
                <a
                  key={route.id}
                  href={route.path}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    navigate(route.path)
                  }}
                  className={cn(
                    'rounded px-1 py-0.5',
                    isActive ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {t(route.labelKey)}
                </a>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <LocaleToggle />
          <ThemeToggle />
          <ConnectionStatus />
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        {active.id === 'matrix' ? (
          <Suspense fallback={<Skeleton lines={8} className="w-full max-w-2xl p-8" />}>
            <MatrixScreen registerCommands={setScreenCommands} />
          </Suspense>
        ) : (
          <HomeScreen />
        )}
      </main>

      <footer className="border-t border-edge px-6 py-2">
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.id} className="flex items-center gap-2">
              <kbd className="rounded border border-edge bg-surface px-1.5 py-0.5 font-mono">
                {shortcut.keys}
              </kbd>
              <span>{t(shortcut.descriptionKey)}</span>
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

export function App() {
  // ToastProvider wraps the shell so every screen (and the header theme toggle)
  // can raise a toast.
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  )
}
