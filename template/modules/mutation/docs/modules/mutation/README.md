# Module: mutation

Mutation testing for both languages: StrykerJS over the TS workspaces (nightly
full run + per-PR incremental on the critical modules) and `cargo-mutants
--in-diff` over the Rust host, restricted to each PR's own diff. Coverage says
your tests RAN the code; mutation says they would NOTICE it breaking.

## What it adds

| File | Purpose |
| --- | --- |
| `stryker.config.mjs` | nightly full-run config (measures, break: null) |
| `stryker.incremental.mjs` | per-PR config: critical modules, break >= 80 |
| `.github/workflows/mutation.yml` | nightly full + per-PR incremental + cargo-mutants jobs |

## Prerequisites

```
pnpm add -D -w @stryker-mutator/core @stryker-mutator/vitest-runner
```

(This also flips knip's built-in Stryker plugin on, so the config files register
as entries instead of dead code.) cargo-mutants is installed by CI (pinned via
taiki-e/install-action) — nothing to add locally unless you want local runs:
`cargo install cargo-mutants --locked`.

## How enabling works

```
npx tauri-postgres-agent-harness enable mutation
```

The workflow is live immediately; the per-PR jobs are ADVISORY
(`continue-on-error: true`) by design. **Rollout:** run the nightly full job a few
times, narrow `mutate` in `stryker.incremental.mjs` to your genuinely critical
modules, confirm they clear 80%, then delete the `continue-on-error` lines to
make the gate blocking. An unmeasured hard threshold is either vacuous or a
permanent red light — both train people to ignore it.

## How this gate can FAIL (anti-vacuity)

- Delete one assertion from `packages/importer/src/parse.test.ts` and run
  `pnpm exec stryker run stryker.incremental.mjs` → surviving mutants appear in
  the report; with the threshold active the run exits non-zero.
- Rust: `cd apps/desktop/src-tauri && cargo mutants --in-diff <diff>` against a
  PR that changes `lib.rs` logic without touching its tests → surviving mutants.

## Honest limits

- NOT in `pnpm validate` or the Stop hook — minutes-to-hours of runtime.
- `packages/schema/src` is excluded: mutants in table/DTO declarations are killed
  by `tsc`, not tests; including them inflates the score without adding safety.
- Deterministic same-turn test-edit bans were rejected (see
  docs/harness/gates-catalog.md) — this module is the mechanism that catches the
  damage instead.
