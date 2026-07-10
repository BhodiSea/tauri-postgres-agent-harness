// End-to-end eval pipeline over the pinned holdout fixture: prompt file →
// FakeInferenceProvider (canned recordings, schema-validated) → scoreItems.
// The expected numbers are exact by construction of the fixture; if they
// drift, either the fixture, the scorer, or the schema changed behavior.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ExtractionResult } from './extract.js'
import { extractionResultSchema, loadExtractionPrompt } from './extract.js'
import { FakeEmbeddingProvider, FakeInferenceProvider } from './fake.js'
import type { ScoredItem } from './score.js'
import { scoreItems } from './score.js'

const tagSchema = z.strictObject({ axis: z.string().min(1), code: z.string().min(1) })
const holdoutSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string().min(1),
      input: z.string().min(1),
      gold: z.array(tagSchema),
      // Raw recording of the model reply; the provider validates it through
      // extractionResultSchema, exactly as a live adapter would.
      canned: z.unknown(),
    }),
  ),
})

const holdoutRaw: unknown = JSON.parse(readFileSync(new URL('../fixtures/holdout.json', import.meta.url), 'utf8'))
const holdout = holdoutSchema.parse(holdoutRaw)

describe('holdout fixture integrity', () => {
  it('has the pinned item count', () => {
    expect(holdout.items).toHaveLength(4)
  })

  it('every canned evidence span is a verbatim substring at its stated offsets', () => {
    for (const item of holdout.items) {
      const canned = extractionResultSchema.parse(item.canned)
      for (const { evidence } of canned.tags) {
        expect(item.input.slice(evidence.start, evidence.end)).toBe(evidence.quote)
      }
    }
  })
})

describe('eval pipeline (deterministic fake — no live model calls)', () => {
  it('scores the fake provider against the holdout with exact per-axis P/R/F1', async () => {
    const provider = new FakeInferenceProvider(new Map(holdout.items.map((item) => [item.input, item.canned])))
    const prompt = loadExtractionPrompt()
    expect(prompt).toContain('extract.v1')

    const scored: ScoredItem[] = []
    for (const item of holdout.items) {
      const result: ExtractionResult = await provider.chatJson(extractionResultSchema, prompt, item.input)
      scored.push({ gold: item.gold, predicted: result.tags.map(({ axis, code }) => ({ axis, code })) })
    }

    expect(scoreItems(scored)).toEqual([
      // hold-001 INTRO hit, hold-003 ADV missed → 1 tp, 1 fn
      {
        axis: 'difficulty',
        truePositives: 1,
        falsePositives: 0,
        falseNegatives: 1,
        precision: 1,
        recall: 0.5,
        f1: 2 / 3,
      },
      // hold-003 hallucinates an off-vocabulary axis → pure false positive
      { axis: 'grade', truePositives: 0, falsePositives: 1, falseNegatives: 0, precision: 0, recall: 0, f1: 0 },
      // hold-001 RECALL hit; hold-002 predicts ANALYZE instead of APPLY
      {
        axis: 'skill',
        truePositives: 1,
        falsePositives: 1,
        falseNegatives: 1,
        precision: 0.5,
        recall: 0.5,
        f1: 0.5,
      },
      // hold-001/002/003 hit; hold-004 predicts BIO instead of MATH
      {
        axis: 'subject',
        truePositives: 3,
        falsePositives: 1,
        falseNegatives: 1,
        precision: 0.75,
        recall: 0.75,
        f1: 0.75,
      },
    ])
  })

  it('rejects inputs that have no canned recording (a fake must never improvise)', async () => {
    const provider = new FakeInferenceProvider(new Map())
    await expect(provider.chatJson(extractionResultSchema, 'prompt', 'unrecorded input')).rejects.toThrow(
      /no canned response/,
    )
  })

  it('produces deterministic fixed-dimension fake embeddings', async () => {
    const embedder = new FakeEmbeddingProvider(8)
    const vectors = await embedder.embed(['photosynthesis', 'stoichiometry'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(8)
    const again = await embedder.embed(['photosynthesis'])
    expect(again[0]).toEqual(vectors[0])
    expect(vectors[0]).not.toEqual(vectors[1])
  })
})
