---
description: One-turn vertical-slice entry point (migration+RLS -> DAL -> route+contract -> desktop feature -> tests -> provenance -> green gate).
argument-hint: "[feature-name]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
model: opus
---

Build the feature **$1** as a complete vertical slice in a single turn.

Use the `authoring-vertical-slice` skill and follow its locked order EXACTLY:
migration + RLS -> DAL -> route + contract regen -> desktop feature -> tests ->
provenance -> green gate.

Delegate each layer to its specialist subagent:

- schema / migration + RLS -> `migration-rls-author`
- the DAL + route contracts (`apps/server/src/dal/$1.ts`) -> `dal-author`
- the test suite (isolation target + units) -> `test-author`

The MAIN THREAD runs the scaffold and the contract regen (the `dal-author` subagent
has no Bash):

```
node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs $1
pnpm openapi:emit   # after any route change; the contracts gate diffs the committed file
```

The scaffold deliberately does NOT create the migration file — migrations are
append-only (the write-guard denies edits to any existing
`packages/schema/drizzle/*.sql`), so the migration is composed completely and written
ONCE as a new file, with its `meta/_journal.json` entry.

For invariant-touching work (auth, RLS, migrations, CSP/capabilities), it is strongly
recommended to write `specs/$1.md` first and get sign-off before implementing.

Before you finish (provenance is REQUIRED — the turn is not done without it):

- run the `torvalds-reviewer` subagent and require `VERDICT: SHIP`;
- run the `security-reviewer` if migrations / RLS / the DAL / db context / auth /
  API middleware changed;
- run the `tauri-security-reviewer` if `tauri.conf.json` / `capabilities/` /
  `src-tauri/**` / `src/ipc/**` / the isolation app changed;
- run the `accessibility-reviewer` if desktop UI or the keyboard registry changed;
- emit and verify the ADR — run `/adr $1` FIRST (so the ADR Sources list is itself
  verified), THEN run `/verify-citations` and require `CITATIONS: CLEAN`.

Every non-trivial decision carries `// SOURCE:` (`--` in SQL), ideally with a
`[corpus: <id>]` reference. The turn ends ONLY when `pnpm validate` is green and
`pnpm test:rls` / `pnpm test` pass. The Stop hook enforces exactly this (it invokes
`node tools/validate.mjs`, `node tests/rls/run-rls.mjs`, and vitest directly) — do
not stop on a red build.

Current working tree for context: !`git status --short`
