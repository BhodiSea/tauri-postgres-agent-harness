import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from './Button'

interface AppDialogProps {
  readonly title: string
  readonly open: boolean
  readonly onClose: () => void
  readonly children: ReactNode
}

// Native <dialog> + showModal(): focus trap, Escape-to-close, backdrop, and
// focus restore to the opener all come from the platform (WebView2 = Chromium)
// instead of a hand-rolled trap that drifts from the spec. jsdom lacks
// showModal — the feature-detected fallback keeps unit tests rendering real
// content without pretending to trap focus.
// SOURCE: WAI-ARIA APG dialog (modal) pattern — native dialog element [corpus: wcag/character-key-shortcuts]
export function AppDialog({ title, open, onClose, children }: AppDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
      // showModal focuses the dialog's first focusable control (the header Esc
      // button). A child marked data-autofocus — the palette's combobox input —
      // claims initial focus instead: the same contract as the native
      // `autofocus` attribute, which React deliberately does not render.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    } else if (!open && dialog.open) {
      // close() restores focus to the pre-open element — correct for a plain
      // Escape, WRONG when the action that closed the dialog already moved
      // focus elsewhere (a palette command focusing a grid cell runs its
      // effect before this one, child-before-parent). If something OUTSIDE the
      // dialog holds focus, closing must not yank it back.
      const outside =
        document.activeElement instanceof HTMLElement && !dialog.contains(document.activeElement)
          ? document.activeElement
          : null
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
      outside?.focus()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-lg border border-edge bg-surface p-0 text-ink backdrop:bg-canvas/80"
    >
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="outline" size="sm" onClick={onClose}>
          Esc
        </Button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  )
}
