import { useI18n } from '../../i18n'
import type { MatrixRow } from './matrixData'

// A hand-rolled SVG value-distribution strip (chart libraries are lint-banned in
// this feature). A histogram of one column's values across all rows; role="img"
// with a descriptive label carries the meaning to assistive tech, and the fill
// is the single accent the matrix screen spends.
const BINS = 24
const VIEW_WIDTH = 240
const VIEW_HEIGHT = 40

interface MatrixSummaryProps {
  readonly rows: readonly MatrixRow[]
  /** Which column to summarize (default: the first). */
  readonly columnIndex?: number
  /** The column's header, ALREADY TRANSLATED by the caller (MatrixPanel resolves
   *  MatrixColumn.labelKey). This component interpolates it; it does not look it
   *  up — the summary should not have to know how a column names itself. */
  readonly columnLabel: string
}

export function MatrixSummary({ rows, columnIndex = 0, columnLabel }: MatrixSummaryProps) {
  // Above the empty-rows return: a hook may not run conditionally.
  const { t } = useI18n()
  if (rows.length === 0) return null
  const values = rows.map((row) => row.values[columnIndex] ?? 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const counts = new Array<number>(BINS).fill(0)
  for (const value of values) {
    const bin = Math.min(BINS - 1, Math.floor(((value - min) / span) * BINS))
    counts[bin] = (counts[bin] ?? 0) + 1
  }
  const peak = Math.max(...counts, 1)
  const barWidth = VIEW_WIDTH / BINS

  return (
    <svg
      role="img"
      // `count` drives Intl.PluralRules, so a one-row matrix reads "across 1 row"
      // rather than the "1 rows" this label used to hardcode.
      aria-label={t('matrix.summary.aria', {
        count: rows.length,
        column: columnLabel,
        rows: rows.length,
      })}
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
      preserveAspectRatio="none"
      className="h-10 w-full"
    >
      {counts.map((count, i) => {
        const height = (count / peak) * VIEW_HEIGHT
        return (
          <rect
            key={i}
            x={i * barWidth}
            y={VIEW_HEIGHT - height}
            width={Math.max(0, barWidth - 1)}
            height={height}
            className="fill-accent"
          />
        )
      })}
    </svg>
  )
}
