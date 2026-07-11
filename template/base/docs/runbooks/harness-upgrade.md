# Runbook: harness upgrades and version-ramped checks

What to do when a gate prints a `NOTE — … (ramp: …)` line after a harness
`update`. Short version: nothing broke, a NEW check is running in advisory mode
because your project's seeded content predates it; you sweep, then graduate —
deliberately, by hand.

## Two versions in `.harness/manifest.json`

- **`harnessVersion`** — the installer release that last ran against this tree.
  `update` always advances it.
- **`baseVersion`** — the release vintage of the SEEDED starting content this
  tree actually carries. `init` stamps it equal to `harnessVersion`; `update`
  preserves it (owned gate scripts refresh, but your seeded exemplars, docs
  lists, and locally-tuned surfaces do not), so it only moves when a human moves
  it. Manifests written before 0.1.5 have no `baseVersion`; the harness falls
  back to `harnessVersion` — the version whose seeded content the tree still
  carries.

## What a ramp NOTE means

Gates never ambush an update: a check added in a newer release than your
`baseVersion` runs NOTE-only (`rampNote` in `tools/lib/gate.mjs`). The line

```
<gate>: NOTE — <check> (ramp: live from baseVersion X.Y.Z; this install's baseVersion is A.B.C). …
```

says: the check executed, found what it found, and withheld the red. On a FRESH
install the same check hard-fails — projects grow into gates; fresh scaffolds
start already grown.

## How to graduate

1. **Sweep.** Run `pnpm validate` and fix everything the ramped check reports in
   its NOTE lines, exactly as if they were reds. Pull any new exemplars you want
   first (`npx tauri-postgres-agent-harness update --refresh-seeded <path>` — the
   update report names them).
2. **Bump `baseVersion`** in `.harness/manifest.json` to the version the NOTE
   names (or the current release). This is a HUMAN decision: the file is
   write-guard-protected against agents, so edit it outside an agent session (a
   plain editor is fine). Do not bump past checks you have not swept — every
   ramped check at or below the new `baseVersion` goes live at once.
3. **Re-run `pnpm validate`.** The NOTE is gone and the check is live: from now
   on a violation is a red, which is the point.

A corrupt manifest never ramps anything — the gates fail closed on unparseable
JSON (restore the file from git history; do NOT re-run `init`).
