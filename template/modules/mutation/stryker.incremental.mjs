// Per-PR incremental mutation gate (mutation module). Imports the nightly base
// config, narrows `mutate` to the CRITICAL modules, and sets a hard break
// threshold. ROLLOUT: keep the CI job advisory (continue-on-error in mutation.yml)
// until a measured run confirms the mutated modules clear 80%, then remove the
// advisory flag so this gate blocks per-PR.
// SOURCE: docs/harness/gates-catalog.md (mutation module; >=80% on critical modules)
import base from './stryker.config.mjs'

const config = {
  ...base,
  // Narrow to the modules whose silent breakage is expensive (authz-adjacent
  // maths, data transforms, token verification) once they exist. Example:
  //   mutate: ['apps/server/src/auth/**/*.ts', 'packages/importer/src/**/*.ts', '!**/*.test.ts'],
  mutate: ['apps/server/src/**/*.ts', 'packages/importer/src/**/*.ts', '!**/*.test.ts'],
  thresholds: { break: 80, high: 90, low: 80 },
}

export default config
