// Can-fail proofs for the machinery complexity ratchet (G16). The arithmetic lives in
// scripts/lib/complexity.mjs, so it is tested here as a pure function — measured scores in,
// problems out — without a 15-second ESLint run.
//
// The gate this backs is the one that stops the harness exempting ITSELF from the
// cognitive-complexity <= 15 bar it enforces on every consumer: eleven functions carry an
// eslint-disable, and a disable directive suppresses the rule entirely, so `eslint .` stayed
// green while a disabled function grew without limit. Proven end-to-end elsewhere (grow
// mergeClaudeSettings 19 -> 34: `eslint .` GREEN, ratchet RED); these pin the comparison.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareComplexity, identify, keyByOccurrence, scoreOf } from '../../scripts/lib/complexity.mjs'

const record = { limit: 15, functions: { 'a.mjs::foo': 20, 'b.mjs::bar': 30 } }

test('a function that stayed at or below its record is clean', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.equal(improved.length, 0)
})

test('GREW: a ratcheted function that increased reds — the promise nothing kept', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 21], ['b.mjs::bar', 30]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /GREW to 21 from a recorded 20/)
})

test('NEW: an over-limit function with no record reds — the twelfth function is not free', () => {
  const { problems } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30], ['c.mjs::baz', 18]]),
    record,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /c\.mjs::baz: NEW over-limit function at 18/)
})

test('STALE: a record whose function is gone reds — bank the win, do not hoard the budget', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 20]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /b\.mjs::bar: recorded at 30 but no longer over the limit/)
})

test('improvement is reported, not failed — so the headroom can be banked deliberately', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 17], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.deepEqual(improved, [['a.mjs::foo', 17, 20]])
})

test('identify: reads the function name off a declaration, position-independently', () => {
  assert.equal(identify('export async function init(opts) {'), 'init')
  assert.equal(identify('export function mergeClaudeSettings(a, b) {'), 'mergeClaudeSettings')
  assert.equal(identify('  const parseThing = (x) => {'), 'parseThing')
})

test('identify: an anonymous callback falls back to normalized declaration text', () => {
  const id = identify('  entries.forEach((entry, i) => {')
  assert.match(id, /^anon\(/)
  // Stable across line shifts — it is the text, not a line number.
  assert.equal(id, identify('\t\tentries.forEach((entry, i) => {  '))
})

test('scoreOf: extracts the measured score, or null for an unrelated message', () => {
  assert.equal(scoreOf('Refactor this function to reduce its Cognitive Complexity from 133 to the 15 allowed.'), 133)
  assert.equal(scoreOf('some other lint message'), null)
})

test('keyByOccurrence: two functions that collide on the same name are BOTH kept, not last-write-wins', () => {
  // The exact defect the adversarial review confirmed: a `handle(x)` beside a `handle(y)` both
  // identify() to "a.mjs::handle". A plain Map would keep only the second (16), and the first
  // (30) could then grow unwatched. Occurrence disambiguation keeps both, so growth of EITHER
  // is visible.
  const m = keyByOccurrence([
    { base: 'a.mjs::handle', score: 30 },
    { base: 'a.mjs::handle', score: 16 },
    { base: 'a.mjs::other', score: 20 },
  ])
  assert.equal(m.size, 3)
  assert.equal(m.get('a.mjs::handle'), 30)
  assert.equal(m.get('a.mjs::handle#1'), 16)
  assert.equal(m.get('a.mjs::other'), 20)
})

test('keyByOccurrence: growth of the SECOND occurrence is caught end-to-end via compareComplexity', () => {
  const record = { limit: 15, functions: { 'a.mjs::handle': 30, 'a.mjs::handle#1': 16 } }
  // The second `handle` grew 16 -> 40; the collapsed-Map bug made this invisible.
  const measured = keyByOccurrence([
    { base: 'a.mjs::handle', score: 30 },
    { base: 'a.mjs::handle', score: 40 },
  ])
  const { problems } = compareComplexity(measured, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /a\.mjs::handle#1: GREW to 40 from a recorded 16/)
})
