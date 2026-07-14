import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { Button } from './Button'

// SOURCE: WCAG 2.2 SC 4.1.3 Status Messages — a toast is a polite live-region
// status message; the auto-dismiss delay holds each one on screen long enough
// to read before it clears.
// https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
const TOAST_DISMISS_MS = 6000

/**
 * What the toast is TELLING you. Not decoration: a failed write and a confirmed one used
 * to render as the same pixels, so the only way to learn you had lost data was to read
 * the prose. Tone drives the colour channel AND the announcement urgency — an error is
 * assertive (role="alert"), everything else stays polite.
 * SOURCE: WCAG 2.2 SC 1.4.1 Use of Color — colour is a redundant channel here, never the
 * only one: the message text carries the meaning on its own
 * https://www.w3.org/TR/WCAG22/#use-of-color
 */
export type ToastTone = 'info' | 'error' | 'success'

// Body copy stays `text-ink` (the AAA 7:1 tier) in every tone — the status hue rides the
// BORDER, so colour is added without demoting the text a user actually has to read.
const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-edge',
  error: 'border-danger',
  success: 'border-success',
}

interface ToastItem {
  readonly id: number
  readonly message: string
  readonly tone: ToastTone
}

interface ToastApi {
  /** Defaults to 'info'. Pass 'error' for anything the user must not miss. */
  readonly show: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Access the toast queue. Throws outside a ToastProvider — a wiring bug, loud. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be called inside a ToastProvider')
  return api
}

// Provider + queue + the always-mounted live region, all in ONE module so knip
// sees a single self-contained unit. The region is `aria-live="polite"` rather
// than `role="status"`: ConnectionStatus already owns the single role=status the
// a11y/states/degraded specs select via a nameless getByRole('status'), and a
// second status role is a strict-mode collision. A bare polite live region is an
// equally-announced status surface. Motion: none — no non-motion-safe animation.
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])
  const nextId = useRef(0)
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const dismiss = (id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const show = (message: string, tone: ToastTone = 'info'): void => {
    nextId.current += 1
    const id = nextId.current
    setToasts((current) => [...current, { id, message, tone }])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      dismiss(id)
    }, TOAST_DISMISS_MS)
    timers.current.add(timer)
  }

  // Clear any in-flight auto-dismiss timers on unmount so a late fire can never
  // setState on a torn-down tree.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const api: ToastApi = { show }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-end gap-2 p-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            // An error is announced ASSERTIVELY: the enclosing region is polite, which is
            // right for a confirmation but wrong for "your write was lost" — that must
            // interrupt. role="alert" (not "status") also avoids colliding with the
            // single role=status ConnectionStatus owns.
            role={toast.tone === 'error' ? 'alert' : undefined}
            className={cn(
              'pointer-events-auto flex items-center gap-3 rounded-md border border-l-4 bg-surface px-3 py-2 text-sm text-ink shadow-md',
              TONE_CLASS[toast.tone],
            )}
          >
            <span>{toast.message}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss notification"
              onClick={() => {
                dismiss(toast.id)
              }}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
