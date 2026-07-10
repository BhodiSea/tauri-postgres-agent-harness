// tools/harness.config.mjs — the single source of truth for the quality gate.
// Consumed by tools/validate.mjs (`pnpm validate`), the Stop hook, and CI, so the three
// enforcement layers can never disagree about what "done" means.
//
// HARNESS-PROTECTED: the write-guard hook denies agent edits to this file unless
// HARNESS_ALLOW_SELF_EDIT=1 is set, and CI re-runs the same steps with a hardcoded
// floor (`node tools/validate.mjs --min-floor`) — so editing this config can ADD
// steps but can never weaken the non-negotiable ones.
// SOURCE: docs/harness/README.md (the gate config is harness-protected and mirrored in CI) [corpus: harness/doctrine]

// Each step is [name, shellCommand]. Steps run sequentially, cheap → expensive;
// the first failure stops the run. Toolchain-dependent steps (rust-fmt, rust-check)
// and surface-dependent gate scripts self-skip LOUDLY when their prerequisite is
// absent locally and fail closed in CI (HARNESS_REQUIRE_TOOLCHAINS=1) — a skip
// must never be mistakable for a pass.
export const VALIDATE_STEPS = [
  ['format', 'pnpm exec biome ci .'],
  ['rust-fmt', 'node tools/run-rust-gates.mjs fmt'],
  ['types', 'pnpm exec tsc -b'],
  ['lint', 'pnpm exec eslint . --max-warnings 0'],
  ['provenance', 'node tools/check-sources.mjs'],
  ['tauri-policy', 'node tools/check-tauri-policy.mjs'],
  ['version-sync', 'node tools/check-version-sync.mjs'],
  ['prompts', 'node tools/check-prompts-lock.mjs'],
  ['licenses', 'node tools/check-licenses.mjs'],
  ['schema-rls', 'node tools/check-rls-manifest.mjs'],
  ['migrations', 'node tools/check-migrations.mjs'],
  ['contracts', 'node tools/check-contract-drift.mjs'],
  ['dead-code', 'pnpm exec knip --strict'],
  ['architecture', 'pnpm exec depcruise apps packages --config .dependency-cruiser.cjs'],
  ['build', 'node tools/build-check.mjs'],
  ['rust-check', 'node tools/run-rust-gates.mjs check'],
  // Opt-in gates — uncomment after installing the matching module and its prerequisites
  // (see docs/harness/gates-catalog.md for what each gate needs before it can pass):
  // ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
  // ['perf-budget', 'node tools/check-perf-budget.mjs'],
]

// What the Stop hook runs before a turn may end. These invoke the gate DIRECTLY —
// `node tools/validate.mjs`, `node tests/rls/run-rls.mjs`, `pnpm exec vitest` — never
// through a package.json script name. Script indirection (`pnpm validate`) would let an
// agent redefine "validate" to `true` in package.json (an auto-accepted, unguarded edit)
// and pass a hollow gate; direct invocation keeps the Stop gate tamper-evident, since this
// config and those runners are all write-guard-protected.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
export const STOP_HOOK_STEPS = [
  ['validate', 'node tools/validate.mjs'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  ['unit', 'pnpm exec vitest run --silent'],
]
