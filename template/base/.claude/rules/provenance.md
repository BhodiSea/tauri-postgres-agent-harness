# Provenance & citeability (always loaded)

SOURCE: docs/harness/README.md (provenance rule)

- Every non-trivial design decision in generated code carries an inline
  `// SOURCE: <authoritative URL or corpus id>` on or above the decision line —
  `-- SOURCE:` in SQL files and migrations.
- Decision sites include: RLS policy SQL (`CREATE POLICY`, `FORCE ROW LEVEL
  SECURITY`, `current_setting`/`set_config`), token verification (`jwtVerify`,
  JWKS choices, `clockTolerance`), vector index choices (`USING hnsw`/`ivfflat`,
  opclass), LLM sampling parameters, retry/timeout/rate-limit constants, and any
  security trade-off. The posttool-source-check hook and the `provenance` gate
  (`tools/check-sources.mjs`) run the identical heuristic — per-edit and
  tree-wide.
- Cite version-pinned authorities. When the authority is pinned in the corpus
  (`tools/mcp/corpus/index.json`), append `[corpus: <id>]` and verify it resolves
  with the `corpus_search` MCP tool. Extend the corpus (id, title, url, version,
  text) in the same PR that first cites a new id.
- Emit one ADR per slice via `/adr <slice>` (records live in `docs/adr/`); the
  ADR's **Sources** section must mirror every inline `// SOURCE:` in the slice.
  Then run `/verify-citations` — the read-only `citation-verifier` subagent
  rejects hallucinated or unresolvable citations. A turn does not end until it
  returns `CITATIONS: CLEAN`.
- Reproducibility (secondary): the release pipeline pins toolchains
  (`rust-toolchain.toml`, committed `Cargo.lock`, exact catalog pins) and the
  `ci-provenance` module adds SBOM + build attestation; reference these where CI
  touches the slice.
