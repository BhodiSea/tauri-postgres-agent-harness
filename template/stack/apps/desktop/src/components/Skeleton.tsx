import { cn } from '../lib/utils'

interface SkeletonProps {
  /** How many placeholder bars to render. */
  readonly lines?: number
  /** Width utility for the bars (default: full, last bar short for realism). */
  readonly width?: string
  /** Screen-reader announcement for the held loading state. */
  readonly label?: string
  /** Passed through so a route keeps its states.loading test id. */
  readonly 'data-testid'?: string
  readonly className?: string
}

// A loading placeholder that is INVISIBLE to assistive tech (aria-hidden bars)
// but still ANNOUNCED: one visually-hidden live string carries "Loading…" so a
// screen reader is told the region is busy, never left guessing at empty pulses.
// motion-safe: the pulse animation is dropped under prefers-reduced-motion.
export function Skeleton({
  lines = 3,
  width,
  label = 'Loading…',
  'data-testid': testId,
  className,
}: SkeletonProps) {
  return (
    <div data-testid={testId} className={cn('flex w-full flex-col gap-2', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            'h-4 rounded bg-surface motion-safe:animate-pulse',
            width ?? (index === lines - 1 ? 'w-2/3' : 'w-full'),
          )}
        />
      ))}
    </div>
  )
}
