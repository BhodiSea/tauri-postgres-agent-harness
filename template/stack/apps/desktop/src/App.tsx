import { lazy, Suspense, useState } from 'react'
import { Button } from './components/Button'
import { Skeleton } from './components/Skeleton'
import { ToastProvider, useToast } from './components/Toast'
import { ConnectionStatus, PROBE_CONNECTION_EVENT } from './features/connection/ConnectionStatus'
import { type Command, CommandPalette } from './features/palette/CommandPalette'
import { ShortcutsOverlay } from './features/shortcuts/ShortcutsOverlay'
import { SHORTCUTS, type ShortcutId } from './keyboard/registry'
import { useShortcuts } from './keyboard/useShortcuts'
import { cn } from './lib/utils'
import { navigate, usePathname } from './router'
import { ROUTES } from './routes'
import { HomeScreen } from './screens/HomeScreen'
import { nextPreference, setThemePreference, type ThemePreference, useTheme } from './theme/theme'

const APP_NAME = '{{PROJECT_NAME}}'

// Matrix is a lazy route: its data-dense grid (and react-dom-free rendering path)
// stays out of the initial bundle until the user visits '/matrix'.
const MatrixScreen = lazy(() => import('./screens/MatrixScreen'))

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
}

// Palette key hints derive from the ONE shortcut registry — a palette command
// that mirrors a shortcut looks its combo up here, so the hint can never drift
// from what the keyboard actually does.
const SHORTCUT_KEYS = Object.fromEntries(
  SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys]),
) as Record<ShortcutId, string>

// The header theme control: cycles system → light → dark → system, names the NEXT
// state for assistive tech, and confirms each switch with a toast (the shell's
// first Toast consumer).
function ThemeToggle() {
  const { preference, cycle } = useTheme()
  const toast = useToast()
  const next = nextPreference(preference)
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        cycle()
        toast.show(`Theme: ${next}`)
      }}
    >
      {THEME_LABEL[preference]}
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
  const paletteCommands: readonly Command[] = [
    ...ROUTES.map(
      (route): Command => ({
        id: `nav.${route.id}`,
        title: `Go to ${route.label}`,
        group: 'Navigation',
        subtitle: route.path,
        run: () => {
          navigate(route.path)
        },
      }),
    ),
    {
      id: 'theme.light',
      title: 'Use light theme',
      group: 'Theme',
      run: () => {
        setThemePreference('light')
        toast.show('Theme: light')
      },
    },
    {
      id: 'theme.dark',
      title: 'Use dark theme',
      group: 'Theme',
      run: () => {
        setThemePreference('dark')
        toast.show('Theme: dark')
      },
    },
    {
      id: 'shortcuts.show',
      title: 'Show keyboard shortcuts',
      group: 'View',
      keys: SHORTCUT_KEYS['show-shortcuts'],
      run: () => {
        setShortcutsOpen(true)
      },
    },
    {
      id: 'connection.probe',
      title: 'Probe API connection now',
      group: 'View',
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
          <nav aria-label="Primary" className="flex items-center gap-4 text-xs">
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
                  {route.label}
                </a>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-4">
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

export function App() {
  // ToastProvider wraps the shell so every screen (and the header theme toggle)
  // can raise a toast.
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  )
}
