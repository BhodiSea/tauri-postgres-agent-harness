import { useI18n } from '../i18n'
import { cn } from '../lib/utils'

interface SkeletonProps {
  /** How many placeholder bars to render. */
  readonly lines?: number
  /** Width utility for the bars (default: full, last bar short for realism). */
  readonly width?: string
  /**
   * Screen-reader announcement for the held loading state. Optional: omit it and the
   * component falls back to the catalog's t('common.loading'). It deliberately carries
   * NO literal default — a default in the signature is user-facing copy frozen at the
   * en string, invisible to the locale switch and to the i18n gate.
   */
  readonly label?: string
  /** Passed through so a route keeps its states.loading test id. */
  readonly 'data-testid'?: string
  readonly className?: string
}

// A loading placeholder that is INVISIBLE to assistive tech (aria-hidden bars)
// but still ANNOUNCED: one visually-hidden live string carries the loading copy —
// t('common.loading') unless a caller names a more specific one — so a screen
// reader is told the region is busy, never left guessing at empty pulses.
// motion-safe: the pulse animation is dropped under prefers-reduced-motion.
export function Skeleton({
  lines = 3,
  width,
  label,
  'data-testid': testId,
  className,
}: SkeletonProps) {
  const { t } = useI18n()
  return (
    <div data-testid={testId} className={cn('flex w-full flex-col gap-2', className)}>
      <span className="sr-only">{label ?? t('common.loading')}</span>
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
