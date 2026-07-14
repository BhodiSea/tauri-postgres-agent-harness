import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from '../lib/utils'

// The one text-input primitive — the styling the command palette carried inline.
// All ARIA/combobox wiring spreads THROUGH: callers own the a11y contract, this
// owns the tokens-only look. React 19 ref-as-prop, no forwardRef.
//
// The invalid state is DERIVED from aria-invalid rather than a separate `error` prop:
// Field already computes that flag as the single source of truth, so the border can
// never disagree with what assistive tech is told. It used to keep its resting
// border-edge while invalid — leaving the field a sighted user must fix looking exactly
// like the ones they must not.
// SOURCE: WCAG 2.2 SC 1.4.1 Use of Color — the inline error text + aria-invalid carry
// the meaning; the border is the redundant channel https://www.w3.org/TR/WCAG22/#use-of-color
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly ref?: Ref<HTMLInputElement>
}

export function Input({ type, className, ref, ...props }: InputProps) {
  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true'
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cn(
        'w-full rounded border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted',
        invalid ? 'border-danger' : 'border-edge',
        className,
      )}
      {...props}
    />
  )
}
