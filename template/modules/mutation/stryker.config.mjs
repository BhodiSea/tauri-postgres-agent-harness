// StrykerJS mutation testing — the behavioral net for TS logic (mutation module).
// CI/nightly only (slow): NOT the Stop gate and NOT in `pnpm validate`. Runs the
// vitest unit projects against every mutant. Excluded on purpose:
//   - packages/schema/src: table/DTO declarations — mutants there are killed by
//     the type gate, not tests, so they only add noise
//   - tests / generated bindings: not behavior under test
// The Rust host gets the same treatment from cargo-mutants (see mutation.yml).
// Prereq: pnpm add -D -w @stryker-mutator/core @stryker-mutator/vitest-runner
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  mutate: [
    'apps/server/src/**/*.ts',
    'packages/importer/src/**/*.ts',
    'packages/eval/src/**/*.ts',
    '!**/*.test.ts',
  ],
  reporters: ['progress', 'clear-text', 'html', 'json'],
  testRunner: 'vitest',
  // Score thresholds never break — the SET-based ratchet does
  // (tools/check-mutation-ratchet.mjs compares surviving mutants against the
  // committed baseline after this run). concurrency 1: timeout-killed mutants
  // flip status under parallel load, and the set compare must be deterministic.
  concurrency: 1,
  thresholds: { break: null },
  vitest: { configFile: 'vitest.config.ts' },
}

export default config
