import type { ButtonHTMLAttributes, Ref } from 'react'
import { cn } from '../lib/utils'

// The one button primitive. Consolidating every control here means the
// hover-accent affordance lives in exactly ONE place (styleguide accent budget),
// and a React 19 ref-as-prop signature retires forwardRef. Tokens-only classes
// via cn(); variant/size pick from closed maps, never free-form strings.
type ButtonVariant = 'solid' | 'outline' | 'ghost'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly ref?: Ref<HTMLButtonElement>
}

// The accent-tinted hover border is the SOLE accent highlight across the control
// set — every other control borrows it by choosing the solid variant.
const VARIANT: Record<ButtonVariant, string> = {
  solid: 'border border-edge bg-surface text-ink hover:border-accent',
  outline: 'border border-edge text-ink-muted hover:text-ink',
  ghost: 'text-ink-muted hover:text-ink',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
}

export function Button({
  variant = 'solid',
  size = 'md',
  type,
  className,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      // A <button> defaults to type="submit"; every app button is an action
      // button unless a caller opts into submit.
      type={type ?? 'button'}
      className={cn('rounded font-medium', VARIANT[variant], SIZE[size], className)}
      {...props}
    />
  )
}
