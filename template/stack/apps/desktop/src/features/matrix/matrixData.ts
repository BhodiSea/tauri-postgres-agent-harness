import type { Note } from '@app/schema'

// The matrix's data model: dense numeric columns derived from the NoteDto wire
// type, plus a synthetic generator for load/perf work. All hand-rolled — no
// chart or data-grid library (lint-banned in this feature).

export interface MatrixColumn {
  /** Machine key, also the aria/testing handle. */
  readonly key: string
  /** Human column header. */
  readonly label: string
}

export interface MatrixRow {
  readonly id: string
  /** Row header text (a note title, or a synthetic label). */
  readonly label: string
  /** One number per MATRIX_COLUMNS entry, in order. */
  readonly values: readonly number[]
}

// The numeric projection of a note. Every column is derivable from a NoteDto so
// notesToMatrixRows and makeSyntheticRows stay shape-compatible.
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
  { key: 'confidence', label: 'Confidence' },
  { key: 'title', label: 'Title len' },
  { key: 'body', label: 'Body len' },
  { key: 'words', label: 'Words' },
  { key: 'lines', label: 'Lines' },
  { key: 'day', label: 'Day' },
]

const MS_PER_DAY = 86_400_000

function wordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length
}

/** Project real notes onto the matrix columns — deterministic, no clock reads. */
export function notesToMatrixRows(notes: readonly Note[]): readonly MatrixRow[] {
  return notes.map((note) => ({
    id: note.id,
    label: note.title,
    values: [
      note.sourceConfidence ?? 0,
      note.title.length,
      note.body.length,
      wordCount(note.body),
      note.body.split('\n').length,
      Math.floor(Date.parse(note.createdAt) / MS_PER_DAY),
    ],
  }))
}

// SOURCE: mulberry32 — a small, fast, seeded PRNG; deterministic runs are the
// point (Math.random is banned in this feature for reproducibility, and the perf
// subject must render identical rows every time).
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A fixed seed makes makeSyntheticRows(n) reproducible run-to-run and
// prefix-stable across sizes — the property the perf subject and unit tests rely
// on. Golden-ratio constant, arbitrary but stable.
const SYNTHETIC_SEED = 0x9e3779b9

export function makeSyntheticRows(count: number): readonly MatrixRow[] {
  const rng = mulberry32(SYNTHETIC_SEED)
  const rows: MatrixRow[] = []
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `synthetic-${String(i)}`,
      label: `Row ${String(i + 1)}`,
      values: [
        rng(),
        Math.floor(rng() * 80) + 1,
        Math.floor(rng() * 2000),
        Math.floor(rng() * 400),
        Math.floor(rng() * 40) + 1,
        20_000 + Math.floor(rng() * 400),
      ],
    })
  }
  return rows
}

/** Grid display formatting: fractions to 2dp, everything else as an integer. */
export function formatCell(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
