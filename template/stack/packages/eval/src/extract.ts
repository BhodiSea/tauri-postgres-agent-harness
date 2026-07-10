import { readFileSync } from 'node:fs'
import { z } from 'zod'

// The versioned extraction contract. The prompt file is immutable once
// committed — tools/prompts.lock.json pins its sha256 and the `prompts` gate
// re-hashes it on every validate run; to change behavior, add extract.v2.md
// and a new lock entry instead of editing v1. The schema below is the exact
// shape the prompt instructs the model to emit (strict: unknown keys reject).
// SOURCE: harness doctrine — prompts are versioned committed files whose
// hashes are locked in tools/prompts.lock.json [corpus: harness/doctrine]

export const extractionResultSchema = z.strictObject({
  tags: z.array(
    z.strictObject({
      axis: z.string().min(1),
      code: z.string().min(1),
      // Provenance: a verbatim quote plus 0-based, end-exclusive character
      // offsets into the item text, so every tag is auditable against its
      // source (input.slice(start, end) === quote).
      evidence: z.strictObject({
        quote: z.string().min(1),
        start: z.int().nonnegative(),
        end: z.int().nonnegative(),
      }),
    }),
  ),
})

export type ExtractionResult = z.output<typeof extractionResultSchema>

export function loadExtractionPrompt(): string {
  return readFileSync(new URL('../prompts/extract.v1.md', import.meta.url), 'utf8')
}
