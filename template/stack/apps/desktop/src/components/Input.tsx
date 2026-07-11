import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from '../lib/utils'

// The one text-input primitive — the styling the command palette carried inline.
// All ARIA/combobox wiring spreads THROUGH: callers own the a11y contract, this
// owns the tokens-only look. React 19 ref-as-prop, no forwardRef.
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly ref?: Ref<HTMLInputElement>
}

export function Input({ type, className, ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cn(
        'w-full rounded border border-edge bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted',
        className,
      )}
      {...props}
    />
  )
}
