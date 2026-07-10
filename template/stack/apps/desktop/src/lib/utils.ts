import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn-style class combinator: clsx for conditionals, tailwind-merge for conflict resolution. */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(...inputs))
}
