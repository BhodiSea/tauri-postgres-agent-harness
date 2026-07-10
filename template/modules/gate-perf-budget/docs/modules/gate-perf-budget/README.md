# Module: gate-perf-budget

A validate-chain performance canary: median-of-N `renderToString` wall time over a
synthetic 10,000-cell matrix fixture, asserted against a committed budget
(`tools/perf-budget.json`). It exists to catch "cell rendering silently got 5×
slower" **inside `pnpm validate`** — cheap (no browser, ~seconds), deterministic
enough (median, warmup runs), and impossible to pass vacuously (the gate fails if
the fixture renders no cells).

## What it adds

| File | Purpose |
| --- | --- |
| `tools/check-perf-budget.mjs` | the gate script (median-of-N over the synthetic matrix) |
| `tools/perf-budget.json` | the budget: cells / runs / medianBudgetMs — reviewable data |

## Prerequisites

- `pnpm install` (react/react-dom resolve from apps/desktop; the gate skips loudly
  locally without an install and FAILS CLOSED in CI).

## How enabling works

```
npx tauri-postgres-agent-harness enable gate-perf-budget
```

then — the one extra step for gate modules — **uncomment the line in
`tools/harness.config.mjs`:**

```js
// ['perf-budget', 'node tools/check-perf-budget.mjs'],
```

That file is harness-protected: a human sets `HARNESS_ALLOW_SELF_EDIT=1` or edits
outside an agent session (the installer prints this hint on enable). From then on
the gate runs in `pnpm validate`, the Stop hook, and CI.

## How this gate can FAIL (anti-vacuity)

- Set `"medianBudgetMs": 1` in `tools/perf-budget.json` → fails with the measured
  median and all samples. Restore afterwards.
- Make renders expensive for real: add a `JSON.parse(JSON.stringify(...))` of a
  large object inside the fixture's cell loop in a scratch branch → fails.
- Empty-render protection: change the fixture to return `null` → fails with
  "fixture rendered no cells", not a fast green.

## Baselines and honest limits

- The default 400ms budget is deliberately loose (CI runners are shared). After a
  week of runs, ratchet it toward ~2× your observed median. Every re-baseline is a
  reviewed diff of `tools/perf-budget.json` — the budget is data, not code.
- This measures **render construction cost**, not user-perceived latency. When the
  real matrix feature exists, keep this canary and ADD an interaction budget:
  a Playwright trace (`page.evaluate` + `performance.measure`) on a pinned
  self-hosted runner, asserting median interaction latency over N runs. CI-hosted
  runners are too noisy for millisecond UX budgets — that is why the default gate
  measures synthetic render cost instead of pretending otherwise.
