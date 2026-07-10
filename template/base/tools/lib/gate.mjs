// Shared gate-script helpers. Doctrine: a gate that cannot run its real check
// SKIPS LOUDLY when the prerequisite is absent locally, and FAILS CLOSED in CI
// (CI=true or HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never look like a pass.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import process from 'node:process'

export const inCI = () =>
  process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

export function ok(gate, msg) {
  console.log(`${gate}: OK${msg ? ` — ${msg}` : ''}`)
  process.exit(0)
}

export function fail(gate, msg) {
  console.error(`${gate}: FAIL — ${msg}`)
  process.exit(1)
}

// Prerequisite missing: loud local skip, hard CI failure.
export function skipOrFail(gate, reason) {
  if (inCI()) {
    console.error(
      `${gate}: FAIL — ${reason} (skips are not allowed in CI: set up the prerequisite or remove the surface)`,
    )
    process.exit(1)
  }
  console.log(`${gate}: SKIPPED — ${reason} (this gate FAILS CLOSED in CI)`)
  process.exit(0)
}

export function failures(gate, list, hint) {
  if (list.length === 0) return
  console.error(`${gate}: FAIL (${list.length})`)
  for (const f of list) console.error(`  - ${f}`)
  if (hint) console.error(hint)
  process.exit(1)
}
