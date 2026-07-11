# tauri-postgres-agent-harness

A deterministic agent harness for **Tauri 2 + React 19 + Hono/Node 22 + Drizzle +
Postgres 16 (FORCE RLS) + pnpm monorepos** shipped as signed Windows `.exe`. It makes
"done" mean **green gate**: a Claude Code Stop hook that refuses to end an agent's turn
until the full validation chain passes, security invariants enforced as lint rules
*and* pre-write guards, RLS isolation tests against real Postgres with seeded positive
controls, Tauri capability/CSP policy gates, and supply-chain-hardened CI across
**both** the npm and crates ecosystems.

Packaged once, installable into any new or existing project — sibling of
[next-supabase-agent-harness](https://github.com/BhodiSea/next-supabase-agent-harness),
same doctrine, rebuilt for the desktop stack.

```sh
# Bootstrap a new monorepo (green out of the box: all 22 gates + RLS suite + unit tests)
npx --yes github:BhodiSea/tauri-postgres-agent-harness init

# Retrofit an existing Tauri + Hono pnpm workspace (merge, never clobber, diff report)
npx --yes github:BhodiSea/tauri-postgres-agent-harness init --dir .

# Later
npx --yes github:BhodiSea/tauri-postgres-agent-harness update   # pull harness fixes
npx --yes github:BhodiSea/tauri-postgres-agent-harness doctor   # integrity + wiring check
```

Pin installs to a tag for reproducibility: `github:BhodiSea/tauri-postgres-agent-harness#v0.1.1`.
This repo is also a **GitHub template** ("Use this template" → `pnpm bootstrap` consumes
the checkout into a project in place), and its agents/commands/skill are installable as a
**Claude Code plugin** (`/plugin marketplace add BhodiSea/tauri-postgres-agent-harness`).

## The three enforcement layers

Prompts are advisory; these are not.

| Layer | When | What |
|---|---|---|
| **Agent-time hooks** | every tool call / turn end | `pretool-bash-guard` (blocks `rm -rf`, force-push, `--no-verify`, `drizzle-kit push`, `knip --fix`, bulk updates, `.env` reads, signing-material and migrator-DSN misuse), `pretool-write-guard` (append-only migrations, Tauri CSP/isolation/capability weakenings, GUC discipline, `VITE_` secrets, desktop↛db imports, DAL `withUserContext` requirement; protects the gate's own config), `posttool-source-check` (every decision site needs `// SOURCE:` / `-- SOURCE:`), and the **Stop validate-gate**: exit 2 until `pnpm validate` + RLS suite + unit tests are green — the turn cannot end on a red build. All hooks **fail closed** (a crashed guard blocks, unit-tested with malformed stdin). |
| **Commit-time** | lefthook | biome on staged files, gitleaks secret scan, commitlint; typecheck + eslint + knip on pre-push. |
| **CI** | every PR | The identical gate chain via `tools/validate.mjs --min-floor` (a locally-weakened config cannot weaken CI), plus a Rust lane (clippy `-D warnings`, cargo test, cargo-deny, capabilities-vs-schema), a real-Postgres RLS job, a Playwright mock-IPC lane (axe WCAG 2.2 AA + degraded network), migration-safety (squawk + append-only + ADR coupling), api-contract (regen-diff + oasdiff), CodeQL, osv-scanner over **both lockfiles**, gitleaks, actionlint + zizmor — all actions SHA-pinned, Renovate-maintained. |

## The gate chain

`pnpm validate` runs `tools/validate.mjs`, driven by a single config
(`tools/harness.config.mjs`) shared by the Stop hook and CI so the three can never
drift (22 steps, cheap → expensive). CI's `--min-floor` runs the frozen snapshot
`tools/validate.floor.json` (write-guard-protected, fail-closed if missing, asserted
equal to the config on every PR) — a locally-weakened config cannot weaken CI:

format (biome) → **gate-integrity** (manifest sha over the gate scripts/hooks — tampering
is turn-fatal) → rust-fmt → types (`tsc -b`, max strictness) → lint (typescript-eslint
**strictTypeChecked** + jsx-a11y strict + React Compiler rules + cognitive-complexity ≤ 15
+ import bans, `--cache`) → provenance (`SOURCE:` on every decision site; citations must
RESOLVE against a sha-pinned corpus) → **tauri-policy** (isolation pattern on, CSP pinned +
non-null + no wildcard/plaintext origins, identifier lock, offline WebView2,
least-privilege capabilities, zero-flash backgroundColor) → version-sync (one version
everywhere, exact pins for rc-churn tools, single zod instance) → prompts (hash-locked,
versioned LLM prompts) → licenses (allowlist on the production tree) → **schema-rls**
(every `pgTable` has FORCE RLS + per-operation initPlan policies + a leading-column owner
index + runtime isolation-matrix wiring, or a reviewed exemption) → migrations
(append-only, DML-free, destructive-needs-ADR) → contracts (openapi regen-diff +
tsconfig-references sync) → dead-code (`knip --strict`, zero ignores) → architecture
(dependency-cruiser: desktop never imports server/db, driver confined to `db/client`,
`db/context` DAL-only, no circulars) → build (vite build + **bundle-purity grep** + gzip
byte budgets) → rust-check (`cargo check --locked` + tauri-specta bindings drift) →
**styleguide** (tokens-only design system: erased default palette, no raw hex/px/inline
styles/arbitrary-value escapes, accent budget, light+dark theme closure with **WCAG
contrast computed from the OKLCH token values** — both themes, no prose contrast tables) →
perf-budget (median-of-N render budget over the **real virtualized matrix component**,
re-measure-once, vacuous-render fail) → **route-manifest** (every screen registered with
loading/empty/error states; path validity + uniqueness; features-dir closure) → **e2e**
(the whole Playwright lane — axe per state, keyboard walk with computed focus-visibility,
focus traps — as an agent-time gate) → docs-sync (AGENTS.md gate list == the chain;
advertised commands exist). The expensive gates are content-hash **stamped**: unchanged
inputs make a warm validate skip build/contracts/licenses/rust-check/**e2e**/version-sync
in milliseconds (a vacuous run never stamps; CI always re-runs everything), and the Stop
hook's `--report-all` runs the read-only gates through a small concurrency pool.

Rust/database gates **skip loudly** without the toolchain locally and **fail closed in
CI** (`HARNESS_REQUIRE_TOOLCHAINS=1`) — a skip is never mistakable for a pass.

The Stop hook then runs the **RLS isolation suite** against real Postgres (docker-compose,
digest-pinned pgvector image): seeded positive controls (a deny-all database can never
pass vacuously), the cross-user isolation matrix, insert-smuggle → SQLSTATE 42501,
a pooled-connection GUC-leak detector, and a pg_catalog gate (FORCE RLS flags, per-op
policies, pgvector ≥ patched version, app role has no BYPASSRLS) — then the unit suite.

Opt-in modules (10): `ci-windows-release` (sign → verify → NSIS silent-install smoke →
Defender scan → size budget), `ci-windows-e2e` (tauri-driver + TLS-inspection/EDR/long-path
resilience), `ci-macos`, `ci-provenance` (SLSA + SBOM npm+cargo), `mutation` (Stryker +
cargo-mutants), `gate-a11y-deep` (NVDA checklist + deep axe lane), `crash-reporting`
(redaction policy + tests; the Sentry transports ship as documented hand-apply patches),
`ops-backup` (pgBackRest + HITL state-machine test seams), `eval-live` (GPU runner + GBNF
pre-validation; live scoring is a marked project seam), `observability` (OTel span-name
manifest + tests; the NodeSDK wiring ships as a documented hand-apply patch). Each module
README carries an "Honest limits" section — what ships wired vs. as a seam. The former
`gate-perf-budget`/`gate-styleguide` modules were promoted into the default chain in
v0.1.3 and retired. Enable with `npx … enable <module>`. Catalog:
[docs/harness/gates-catalog.md](template/base/docs/harness/gates-catalog.md).

## Security invariants (lint + hook enforced)

- Authorization lives **only** in the server DAL: every DAL module acquires the database
  through `withUserContext(userId, …)` — a transaction-local `SET LOCAL app.user_id`
  under **FORCE ROW LEVEL SECURITY**. Tauri capabilities/IPC are never the authz boundary.
- Never a session-wide identity GUC (`set_config(…, false)` is blocked — pooling leak).
- The migrator DSN (RLS-bypassing owner role) is confined to drizzle-kit and the
  migration test runner.
- Migrations are **append-only**; destructive DDL requires an ADR.
- Entra ID tokens are verified with pinned iss/aud/alg (`jose`), stub mode is
  **boot-time fatal in production**, and the stub/entra verification paths are
  byte-identical.
- Never `dangerouslySetInnerHTML`; never `VITE_`-prefixed secret names (compiled into
  the bundle); Tauri APIs only via the typed `src/ipc/` facade; the shipped CSP and
  isolation pattern cannot be weakened without `HARNESS_ALLOW_SELF_EDIT=1`.

## Provenance: code you can cite

Every non-trivial decision carries `// SOURCE: <authority> [corpus: <id>]` (SQL:
`-- SOURCE:`), resolved against a version-pinned corpus (`tools/mcp/corpus/index.json`)
served by a local MCP server. A PostToolUse hook flags uncited decisions mid-turn;
`tools/check-sources.mjs` mirrors it in CI; the `citation-verifier` subagent rejects
hallucinated citations; `/adr` emits an Architecture Decision Record per slice. A second
MCP server, `rls_verify`, gives agents a mid-turn cross-user isolation probe (with a
positive control — never a vacuous green).

## The agent roster

Eight subagents: `migration-rls-author`, `dal-author`, `test-author` write;
`security-reviewer`, `torvalds-reviewer`, `accessibility-reviewer`,
`tauri-security-reviewer`, `citation-verifier` are read-only by construction. Three
commands: `/new-feature` (one-turn vertical slice: migration → RLS → DAL → contract →
desktop feature → tests → provenance → green gate), `/adr`, `/verify-citations`.
`AGENTS.md` is the canonical project memory; `CLAUDE.md` is a pure `@AGENTS.md` include
(CI-asserted).

## Tamper evidence (honest limits)

An agent inside the harness cannot trivially weaken the gate: permission `deny` rules
cover `.claude/hooks/**` and `settings.json`; the write-guard blocks edits to the gate
config, every gate script, the lockfiles the gates verify against, lint/architecture
configs, `lefthook.yml`, and `.github/workflows/**` unless a human sets
`HARNESS_ALLOW_SELF_EDIT=1`; `doctor` hash-verifies every harness-owned file (raw bytes,
binaries included) against `.harness/manifest.json`; CI re-runs the canonical floor
regardless of local config; CODEOWNERS pins the harness paths. This is **tamper-evident,
not tamper-proof** — a determined agent with shell access can bypass local enforcement;
CI parity and review are the backstops. Threat model:
[docs/harness/README.md](template/base/docs/harness/README.md).

## What an install gives you

~170 files: the `.claude/` machinery (settings + 5 hooks + 8 agents + 3 commands + rules
+ the vertical-slice skill), the gate configs (biome, eslint, knip, dependency-cruiser,
tsconfig solution + max-strict base, lefthook, commitlint, gitleaks, cspell, deny.toml,
rust-toolchain), `tools/` (validate runner + 9 gate scripts + two MCP servers + corpus),
the RLS/migration test harnesses, the Playwright mock-IPC e2e lane, 8 CI workflows +
Renovate, governance docs (ADR/spec templates, IT-onboarding and expand-contract
runbooks, approved-tools registry) — and a working reference monorepo: Tauri 2 shell
(isolation pattern, committed specta bindings, WCAG-tested keyboard registry, OKLCH
design tokens), Hono server (Entra/stub auth, version-skew middleware, SSE demo,
server-only DAL over an RLS'd table), shared Zod/Drizzle schema package with a
pgvector column, a zero-dep importer with property-based tests, and an LLM eval
package (swappable providers, hash-locked prompt, fixture-scored — no live calls).

Bootstrap is verified **green out of the box** in CI: fresh install → `pnpm install` →
`pnpm validate` (22 gates incl. a real `cargo check` and the Playwright e2e lane) → RLS suite against a live
Postgres → unit tests, on ubuntu and **windows-latest on every PR** — plus a canary job
that injects one violation per gate and asserts it fails (a gate that cannot fail is
deleted), and a nightly Windows `tauri build` that silent-installs and uninstalls the
produced `.exe`.

## Retrofit semantics

Existing projects are never clobbered: existing scripts keep their names (ours land
under `harness:<name>`), existing configs stay (ours land alongside as
`<name>.harness.<ext>` with a conflict report), `pnpm-workspace.yaml` is glob-union
**merged** (catalog pins added only when missing, never downgraded), app code is
untouched, and workspace packages are additive-only. The Stop gate is unaffected by a
script-name collision — it invokes the runners directly. Non-pnpm or single-root
layouts are rejected in v1 with guidance.

## Requirements

Node ≥ 22, pnpm ≥ 11 (Corepack), Docker (for the RLS runtime gates — self-skips
honestly without it), Rust toolchain via rustup (for the Rust gates — same honest skip).
Windows `.exe` builds additionally need the Tauri Windows prerequisites.

## Development (this repo)

See [CONTRIBUTING.md](CONTRIBUTING.md). `node scripts/check-syntax.mjs && node
scripts/hygiene.mjs && node --test "tests/**/*.test.mjs"` — plus the selftest CI matrix
(bootstrap linux/windows / canary / retrofit non-clobber / tauri-build-smoke / hook
exit-code contracts). The multi-agent research and design record behind this harness
ships in [`design/`](design/).

## License

Apache-2.0; everything under `template/**` additionally 0BSD (scaffolded code carries
no attribution requirement). Cite via [CITATION.cff](CITATION.cff).
