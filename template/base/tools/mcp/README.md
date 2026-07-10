# Local MCP servers (`tools/mcp/`)

Two project-scoped stdio MCP servers wired in `.mcp.json` and approved via
`enabledMcpjsonServers` in `.claude/settings.json`. Each has a stable tool contract so the
harness can use them now and the implementation can deepen later.

## `corpus_search` (`corpus-search-server.mjs`)

Grounding/citation lookup over a **version-pinned** standards corpus. The
`citation-verifier` subagent resolves `// SOURCE: [corpus: <id>]` references through it;
slice authors use it to fetch authoritative snippets mid-turn.

- Tools: `corpus_search({query, k?})` → high-signal `{id, version, url, snippet, sha256}` or
  `NO_MATCH`; `corpus_resolve({id})` → the pinned entry (existence/hash check).
- Backing store: `tools/mcp/corpus/index.json` (override with `CORPUS_INDEX_URL`).
- **Stage 1 (now):** keyword match, returns `NO_MATCH` honestly. **Stage 2:** swap for
  embeddings (e.g. pgvector) behind the identical tool contract.

### Adding a corpus entry

Append an object to `tools/mcp/corpus/index.json`:

```json
{ "id": "<namespace>/<slug>", "title": "...", "url": "<version-pinned URL>", "version": "...", "text": "<the exact verified claim>", "sha256": "" }
```

- `url` must be **version-pinned** (a docs page for a pinned major, a tagged file, an RFC).
- `text` is the exact claim you verified by reading the source — **never add an entry you
  haven't read**.
- Internal authorities use your project namespace (e.g. `{{PROJECT_SLUG}}/security`) with a
  repo-relative `url`.
- Verify with `corpus_resolve` before citing the id in a `// SOURCE:` comment.
- `CORPUS_INDEX_URL` overrides the backing store with a corpus JSON **file path** (e.g. a
  shared checkout or a mounted path) — it is not an HTTP fetch. The server treats it as a
  path (stripping a `file://` prefix), ignores an `http(s)://` value or an unexpanded
  `${...}` placeholder, and falls back to the local `corpus/index.json` if the override
  points nowhere — so a bad override never silently blanks the corpus.

## `rls_verify` (`rls-verify-server.mjs`)

Mid-turn cross-tenant isolation probe. After a migration/RLS slice, an author can confirm
tenant A cannot read tenant B's rows before the Stop gate / CI suite runs.

- Tool: `rls_verify({table, tenantColumn?, tenantA, tenantB})` → `RLS: ISOLATED | LEAK | SKIPPED`.
- **Implementation:** connects via `pg` (devDependency) to `SUPABASE_DB_URL` and, inside a
  `READ ONLY` transaction that always ends in `ROLLBACK`: allow-lists the table/column
  against `information_schema.columns` (unknown identifiers are refused, never interpolated),
  drops to the **RLS-subject role** (`SET LOCAL ROLE authenticated` — never superuser), sets
  `request.jwt.claims` to tenant A, and `SELECT count(*)` of tenant B's rows, expecting 0.
- **Never a false green:** no `SUPABASE_DB_URL`, missing `pg`, unknown identifiers, or any
  connection/query error all return `SKIPPED (<reason>)` — only a completed probe returns
  `ISOLATED` or `LEAK`. A **seeded positive control** is required: before impersonating
  tenant A, the probe confirms (as the login role) that tenant B actually owns rows in the
  table; zero baseline rows would make the probe vacuous (an empty or unprotected-but-empty
  table reads as isolated), so it returns `SKIPPED`, never green.

## Security note

`SUPABASE_DB_URL` is a privileged connection string — it lives only in the local server's
env (gitignored via `.claude/settings.local.json`) and must never reach app code. `tools/`
is outside the dependency-cruiser app graph (`app components lib proxy.ts`) and is
ESLint-ignored, so these scripts cannot leak into the shipped bundle. The authoritative
isolation check remains the CI suite (`pnpm test:rls`).

## Env (set in `.claude/settings.local.json`, see the committed `.example`)

`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` (for the official `supabase` MCP server),
`SUPABASE_DB_URL` (rls_verify probe), `CORPUS_INDEX_URL` (optional corpus override).
