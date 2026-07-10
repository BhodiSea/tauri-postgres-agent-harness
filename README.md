# tauri-postgres-agent-harness

> **Status: v0.1.0 in active construction.** The design record is complete
> (see [`design/`](design/)); the implementation is landing in dependency
> order. Do not install from this repo until the first tagged release.

A deterministic agent harness for **Tauri 2 + React 19 + Hono/Node 22 +
Drizzle + Postgres 16 (FORCE RLS) + pnpm monorepo** projects shipped as signed
Windows `.exe`. Sibling of
[next-supabase-agent-harness](https://github.com/BhodiSea/next-supabase-agent-harness),
same doctrine: "done" means **green gate** — a Claude Code Stop hook that
refuses to end an agent's turn until the full validation chain passes,
security invariants enforced as lint rules *and* pre-write guards, RLS
isolation tests against real Postgres, Tauri capability/CSP policy gates, and
supply-chain-hardened CI across **both** the npm and crates ecosystems.

```sh
# Once v0.1.0 ships:
npx --yes github:BhodiSea/tauri-postgres-agent-harness init          # bootstrap a new monorepo
npx --yes github:BhodiSea/tauri-postgres-agent-harness init --dir .  # retrofit an existing one
npx --yes github:BhodiSea/tauri-postgres-agent-harness update        # pull harness fixes
npx --yes github:BhodiSea/tauri-postgres-agent-harness doctor        # integrity + wiring check
```

## Design record

The harness was designed from a multi-agent research and reconciliation
process; the full evidence base ships in [`design/`](design/):

- `repo-familiarization.json` — mechanics of the sibling harness (what carries
  over, what gets re-pointed, gotchas).
- `research-findings.json` — 14 research reports (~140 recommendations, each
  with mechanical enforcement notes) on Tauri 2 packaging/signing/security,
  max-strict TypeScript, testing, hardened CI, plain-Postgres RLS, Hono server
  patterns, desktop UX/perf, local-LLM eval discipline, and more.
- `designs.json` — three architect designs (architecture parity, quality
  maximalist, delivery pragmatist).
- `critic.json` — the adjudicated merge: every divergence resolved, every
  infeasibility fixed, every dropped research finding recovered.

## License

Apache-2.0 for the harness; everything under `template/**` additionally 0BSD
(scaffolded code carries no attribution requirement). See [LICENSE](LICENSE).
