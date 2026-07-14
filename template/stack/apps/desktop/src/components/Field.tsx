import { type ReactNode, useId } from 'react'
import { cn } from '../lib/utils'

// The one form-field primitive: label + control slot + inline error line, with
// the aria contract computed in exactly ONE place. The control is a render
// prop — Field hands the caller the id/aria props and the caller spreads them
// onto whatever control primitive it renders (Input today), so the wiring can
// never be forgotten and Field never clones or introspects children.
//
// The error line carries THREE channels, none of them sufficient alone: the
// aria-describedby relationship (screen readers), the aria-invalid flag, and the
// danger token (sighted users). It used to render in the same `text-ink` as the label,
// so a validation failure was typographically indistinguishable from a hint — and the
// invalid control kept its resting `border-edge`, which is the one place colour is
// genuinely load-bearing: you cannot describe a border to yourself.
// SOURCE: WAI forms tutorial — inline errors are tied to their control with
// aria-describedby and the control is flagged aria-invalid
// https://www.w3.org/WAI/tutorials/forms/notifications/
// SOURCE: WCAG 2.2 SC 1.4.1 Use of Color — the text + ARIA carry the meaning; colour is
// the redundant channel https://www.w3.org/TR/WCAG22/#use-of-color

/** Props Field computes for its control — spread them onto the Input (or peer primitive). */
interface FieldControlProps {
  readonly id: string
  readonly 'aria-describedby': string | undefined
  readonly 'aria-invalid': true | undefined
}

interface FieldProps {
  readonly label: string
  /** Inline error message; undefined/empty renders no error line. */
  readonly error?: string | undefined
  /** Render prop receiving the computed control props. */
  readonly children: (control: FieldControlProps) => ReactNode
  readonly className?: string
}

export function Field({ label, error, children, className }: FieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hasError = error !== undefined && error !== ''
  return (
    <div className={cn('flex w-full flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({
        id,
        'aria-describedby': hasError ? errorId : undefined,
        'aria-invalid': hasError ? true : undefined,
      })}
      {hasError && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
