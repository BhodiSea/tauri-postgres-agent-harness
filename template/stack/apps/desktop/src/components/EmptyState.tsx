import { Button } from './Button'

interface EmptyStateCta {
  readonly label: string
  readonly onClick: () => void
}

interface EmptyStateProps {
  readonly title: string
  readonly description: string
  /** Optional recovery/primary action rendered as a Button. */
  readonly cta?: EmptyStateCta
  /** Passed through so a route keeps its states.empty test id. */
  readonly 'data-testid'?: string
  readonly className?: string
}

// The reference "nothing here yet" surface: a title, a calm explanation, and an
// optional call to action — never a blank panel. Shared so every route's empty
// state reads the same.
export function EmptyState({
  title,
  description,
  cta,
  'data-testid': testId,
  className,
}: EmptyStateProps) {
  return (
    <div data-testid={testId} className={className}>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">{description}</p>
      {cta !== undefined && (
        <Button variant="outline" size="sm" className="mt-3" onClick={cta.onClick}>
          {cta.label}
        </Button>
      )}
    </div>
  )
}
