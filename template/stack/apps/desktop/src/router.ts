import { useSyncExternalStore } from 'react'

// A hand-rolled SPA router — pushState + a custom event, read through
// useSyncExternalStore. No react-router: the app has a handful of routes, and a
// dependency-free store keeps the bundle small and the navigation model
// inspectable. navigate() pushes history and notifies subscribers; usePathname()
// re-renders on Back/Forward (popstate) and on programmatic navigate().

const NAVIGATE_EVENT = 'app:navigate'

/** Push a new history entry and notify pathname subscribers. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback)
  window.addEventListener(NAVIGATE_EVENT, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(NAVIGATE_EVENT, callback)
  }
}

function getSnapshot(): string {
  return window.location.pathname
}

// Server/prerender snapshot: the app origin resolves to the home path.
function getServerSnapshot(): string {
  return '/'
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
