# The harness doctrine

This document is the canonical reference for every `// SOURCE: docs/harness/README.md`
citation in the codebase. It explains **why** each enforcement mechanism exists, **which
script implements it**, and **where the honest limits are**. The per-gate reference lives
in [gates-catalog.md](./gates-catalog.md).

## The gate is the enforcement

The one-sentence thesis: **quality is a deterministic gate, not a request.** Memory files
(AGENTS.md, `.claude/rules/*.md`) are advisory context; hooks, gate scripts, and CI are
the enforcement. The harness is built so the model produces green-on-first-try code and
the gate rarely has to fire — but when it does fire, it cannot be talked out of it.

Every mechanism belongs to one of six layers:

| # | Layer | Concrete mechanisms |
|---|---|---|
| 1 | **Grounding / context** | AGENTS.md + `.claude/rules/*.md`, the pinned corpus (`tools/mcp/corpus/index.json`), `specs/_template.md` |
| 2 | **Generation** | plan-mode design first; data structures before code (the quality bar in AGENTS.md) |
| 3 | **In-loop verification** | mid-turn MCP tools (`corpus_search`, `rls_verify`), `posttool-fast-check.mjs` per-edit feedback |
| 4 | **Provenance capture** | `// SOURCE:` + `[corpus: <id>]` comments, `posttool-source-check.mjs`, `tools/check-sources.mjs`, one ADR per slice (`/adr`) |
| 5 | **Adversarial review** | read-only reviewer subagents (`security-reviewer`, `torvalds-reviewer`, `citation-verifier` via `/verify-citations`) |
| 6 | **Gated completion** | the Stop hook (`stop-validate-gate.mjs`) running the full validate chain with exit-2 semantics; CI as the floor |

Layers 1–2 raise the probability of correct output; layers 3–6 make incorrect output
unable to ship. Doctrine: never rely on a layer-1 instruction for anything a layer-3/6
gate could enforce deterministically.

## One gate config, three enforcement layers

`tools/harness.config.mjs` is the single source of truth for what "done" means:
`VALIDATE_STEPS` (the 16-step chain `pnpm validate` runs) and `STOP_HOOK_STEPS` (what the
Stop hook runs — validate plus the RLS and unit suites). Three enforcement layers consume
it and can therefore never disagree:

1. **`pnpm validate`** → `node tools/validate.mjs` — the developer/agent fast path.
2. **The Stop hook** → runs `STOP_HOOK_STEPS` **directly** (`node tools/validate.mjs`,
   `node tests/rls/run-rls.mjs`, `pnpm exec vitest run --silent`) — never through a
   package.json script name, because script indirection would let an agent redefine
   `validate` to `true` in package.json (an auto-accepted, unguarded edit) and pass a
   hollow gate. **The Stop gate defines done** locally.
3. **CI** → re-runs `node tools/validate.mjs --min-floor`, which merges in a hardcoded
   copy of all 16 canonical steps. **The CI floor** means editing the config can ADD
   steps but can never weaken the non-negotiable ones on a PR.

The gate config is harness-protected and mirrored in CI: `harness.config.mjs`,
`validate.mjs`, every gate script, and the runners the Stop hook invokes are all
write-guard-protected (see tamper evidence), and the selftest suite asserts
FLOOR ↔ VALIDATE_STEPS lockstep.

## The hook map (deterministic enforcement)

Exit-code semantics (the crux of the design):

- **exit 0** — proceed. Stdout may carry a structured JSON decision
  (`hookSpecificOutput.permissionDecision: "deny"` on PreToolUse blocks the call with a
  machine-readable reason).
- **exit 2** — block, and **stderr is fed back to the model** as the correction signal.
  On `PreToolUse` this blocks the tool call; on `Stop` it forces the turn to continue.
- **any other non-zero** — non-blocking error; the action proceeds. Security hooks must
  therefore always use exit 2 (or the structured deny), never exit 1.
- `PostToolUse` cannot un-run a tool; its exit 2 surfaces stderr so the model fixes what
  just landed.

| Event | Matcher | Script | Enforces |
|---|---|---|---|
| PreToolUse | `Bash` | `.claude/hooks/pretool-bash-guard.mjs` | denies destructive shell, secret access, migration bypasses (see below) |
| PreToolUse | `Edit\|Write\|MultiEdit` | `.claude/hooks/pretool-write-guard.mjs` | blocks invariant-violating file **content** before it lands; denies edits to harness-owned paths |
| PostToolUse | `Edit\|Write\|MultiEdit` | `.claude/hooks/posttool-fast-check.mjs` | fast per-file feedback (Biome / cargo fmt), non-blocking |
| PostToolUse | `Edit\|Write\|MultiEdit` | `.claude/hooks/posttool-source-check.mjs` | flags decision sites lacking `// SOURCE:` (exit 2) |
| Stop | — | `.claude/hooks/stop-validate-gate.mjs` | runs `STOP_HOOK_STEPS`; exits 2 with failures on stderr until green |

### `.claude/hooks/lib/hookio.mjs` (hooks fail closed)

Shared Node-only I/O helpers (stdin JSON parsing, `block()`, `denyTool()`, `pass()`) —
no `jq`, no Bash. **Hooks fail closed:** `uncaughtException`/`unhandledRejection`
handlers exit 2, because a crashed guard that exits 1 would be treated as a
*non-blocking* hook error and wave the action through. Malformed (non-empty,
unparseable) stdin throws → blocked. A broken harness blocks; it never silently passes.

### stop-validate-gate (the unbreakable core)

A turn **cannot end** while the gate is red. Details that matter:

- **Config-driven:** it imports `STOP_HOOK_STEPS` from `tools/harness.config.mjs`, so
  projects extend the gate without editing the hook (itself harness-protected). If the
  config cannot load, it falls back to `pnpm validate` and warns — never skips.
- **Loop guard:** `stop_hook_active: true` in the hook input escalates the message
  ("STILL red after a prior continuation"); the gate re-runs until green.
- **Bound:** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (`.claude/settings.json` `env`) caps
  consecutive blocks so a genuinely stuck session terminates instead of looping forever.
  The cap is the safety valve; the gate is the contract.
- **Failure output is truncated tail-first** (last ~4000 chars per step) so the model
  sees the actual errors; a 64 MB exec buffer prevents false FAILs on verbose steps.

### pretool-bash-guard

Deterministic regex denial of the commands permission pattern-matching handles
unreliably. A high-value tripwire, NOT a sandbox — obfuscated commands can evade
substring checks; the settings.json deny list and CI are the primary controls. The rule
table denies: `rm -rf`, force-push, `git reset --hard`, `git commit --no-verify`, fork
bombs, reading `.env*` (the committed `.env.example` is exempt), `drizzle-kit push`
(bypasses migration files), `drizzle-kit drop` (deletes migration history),
`knip --fix`, bulk `pnpm|cargo update` (Renovate-owned), `MIGRATOR_DATABASE_URL` outside
drizzle-kit migrate/generate/check and `tests/migrations/` (it is this stack's
RLS-bypassing role), destructive raw SQL via psql/pg_restore, and any shell contact with
updater signing material (`TAURI_SIGNING_PRIVATE_KEY`, minisign secret keys).

### pretool-write-guard

The only reliable place to stop forbidden code being **written** (lint would catch it
later; this catches it before it lands). Three duties:

1. **Tamper protection** — denies edits to the PROTECTED list (below) without
   `HARNESS_ALLOW_SELF_EDIT=1`.
2. **Append-only migrations** — editing an existing `packages/schema/drizzle/*.sql`
   is denied outright; new migration files are fine.
3. **Content checks** on the written text: `tauri.conf.json` weakenings (null CSP,
   `dangerous*` options, brownfield pattern, non-offline WebView2 install mode),
   capability weakenings (remote IPC, shell/process permissions, `**` fs scopes),
   `Cargo.toml` dropping `unsafe_code = "forbid"`, `WITH RECURSIVE` without
   CYCLE/visited, `dangerouslySetInnerHTML`, VITE_-prefixed secret names, session-scoped
   GUCs, vitest workspace files, desktop imports of server/db modules, unwrapped
   `@tauri-apps/*` imports, and DAL modules missing `withUserContext`.

It deliberately does NOT blanket-protect `tauri.conf.json` / capabilities / `Cargo.toml`
— adding a permission or crate is routine vertical-slice work; only the specific
weakenings are content-checked. It exempts `.claude/**` and test bodies, which
legitimately reference banned patterns, and judges positive requirements (X must be
present) only on whole-file writes.

### PostToolUse fast single-file feedback

`posttool-fast-check.mjs` is NON-BLOCKING (exit 0): Biome `--write` on the single
changed file; `cargo fmt` for `.rs` files when cargo is present. Heavy checks (`tsc -b`,
eslint, knip, depcruise, cargo check, vite build) live on the Stop gate / CI so the edit
loop stays tight. The Stop gate is authoritative; this hook only shortens the distance
to green.

### posttool-source-check

The in-session half of the provenance gate: after every edit it scans the changed
`.ts/.tsx/.sql` file for decision-site keywords (RLS policy SQL, `set_config`/
`SET LOCAL`, `jwtVerify`/JWKS/`clockTolerance`, hnsw/ivfflat/opclass choices, sampling
and retry/timeout constants) and exits 2 listing any that lack a `// SOURCE:`
(`-- SOURCE:` in SQL) within a 3-line window. It only fires inside the agent session —
`tools/check-sources.mjs` runs the **identical heuristic** over the whole tracked tree in
`pnpm validate` and CI, so the two can never disagree. Keep the DECISION regex and the
window in lockstep when editing either. Comment lines that merely mention a keyword are
not decision sites; tests, generated bindings, drizzle meta, and JSON (which cannot carry
comments — CSP/installer decisions are documented in ADRs) are skipped.

## Tamper evidence (honest limits)

The harness protects its own machinery, but be precise about the claim: it is
**tamper-EVIDENT, not tamper-proof**. An agent (or developer) with shell access can
ultimately modify anything in the working tree. The design goal is that tampering
(a) requires a deliberate, visible override, (b) leaves a diff a human reviews, and
(c) is caught by CI even if the local session was fully compromised.

The layers, in order of engagement:

1. **Permission denies** in `.claude/settings.json` — network exfiltration
   (`curl`/`wget`), `.env` and `.dev-auth/` reads, ssh keys, force-push, hard reset, and
   direct writes to `.claude/hooks/**`, settings, `.mcp.json`, `.harness/**` are denied
   at the permission layer before any hook runs.
2. **Write-guard PROTECTED paths** — `tools/harness.config.mjs`, `tools/validate.mjs`,
   every `tools/check-*.mjs` + `run-rust-gates.mjs` + `build-check.mjs`, `tools/lib/`,
   the lockfiles gates verify against (`identity.lock.json`, `prompts.lock.json`,
   `rls-exempt.json`), the Stop-hook runners (`tests/rls/run-rls.mjs`,
   `tests/migrations/migration-apply.mjs`), `lefthook.yml`, `.github/workflows/`, and
   the lint/architecture config surface (eslint/biome/knip/depcruise/tsconfig/
   pnpm-workspace/deny.toml/rust-toolchain/gitleaks). A human who genuinely needs to
   change the harness sets `HARNESS_ALLOW_SELF_EDIT=1` for that session — an explicit,
   auditable act, not a default.
3. **The `.harness` manifest** — the installer records a SHA-256 for every
   harness-owned file in `.harness/manifest.json`;
   `npx tauri-postgres-agent-harness doctor` (read-only, CI-friendly exit codes)
   re-hashes the tree so silent in-place edits are evident as drift.
4. **The CI floor** — CI does not trust the config: `node tools/validate.mjs
   --min-floor` enforces the hardcoded step list. Local bypasses change nothing about
   what merges; **CI is the backstop enforcement, hooks are the fast path.**
5. **CODEOWNERS** — harness-owned paths and auth/data surfaces require sign-off from
   {{SECURITY_OWNERS}}, so even an evident tamper needs a human accomplice to land.

## Skip-local / fail-closed-CI asymmetry

Doctrine (implemented in `tools/lib/gate.mjs#skipOrFail`): a gate that cannot run its
real check — cargo missing, no install, no reachable database, surface not yet created —
**SKIPS LOUDLY** locally (`SKIPPED — <reason> (this gate FAILS CLOSED in CI)`) and
**FAILS CLOSED** in CI (`CI=true` or `HARNESS_REQUIRE_TOOLCHAINS=1`). A skip must never
be mistakable for a pass, and CI must never be green because a prerequisite was absent.
This is how one gate chain serves both a laptop without Rust/Docker and the canonical CI
runner, without conditional floor membership: shape-awareness lives INSIDE each gate
script, never in which steps run.

## The security invariants

Enforced as hooks + lint + gates (defense-in-depth); the grounding rules restate them so
the model rarely trips a gate:

- **security-invariants rule** (`.claude/rules/security-invariants.md`) — always-loaded
  restatement of the non-negotiables the write/bash guards enforce.
- **provenance rule** (`.claude/rules/provenance.md`) — the `// SOURCE:` convention and
  the `/adr` + `/verify-citations` flow.
- **desktop-server split rule** (`.claude/rules/desktop-server-split.md`) — path-scoped
  (best-effort; never rely on conditional loading for invariants) treatment of the
  client/server trust boundary.

Doctrine notes for the citations:

- **desktop-server split** — the webview is an untrusted client; Tauri IPC/capabilities/
  CSP are containment, never authorization. `withUserContext(userId, fn)`
  (`apps/server/src/db/context.ts`) is THE authorization boundary: it opens a
  transaction, `SET LOCAL app.user_id`, and everything inside runs as the `app_api`
  role under FORCE RLS. Routes never touch the driver; the DAL returns Zod-parsed DTOs.
  See `.claude/rules/desktop-server-split.md`.
- **GUC discipline** — the RLS identity GUC is transaction-local by construction:
  `set_config('app.user_id', $uuid, true)` / `SET LOCAL`. A session-scoped GUC
  (`set_config(..., false)`, `SET SESSION`) survives the transaction and LEAKS the
  previous user's identity to whoever gets the pooled connection next.
  [corpus: postgres/guc-set-local]
- **append-only migrations** — editing an already-committed migration rewrites history
  that may already be applied to a database; databases that ran the original
  desynchronize silently. New state = new migration. `drizzle-kit push` (schema changes
  with no reviewable file) and `drizzle-kit drop` (deletes history) are blocked.
  [corpus: drizzle/migrations-append-only]
- **migration discipline** — beyond append-only: migrations carry structure, not data
  (DML needs an explicit `-- harness-allow-dml: <reason>` marker), and destructive DDL
  (DROP TABLE/COLUMN, TRUNCATE) must reference an existing ADR via
  `-- adr: docs/adr/<file>`. Two-phase changes follow
  `docs/runbooks/expand-contract.md`.
- **graph queries** — `WITH RECURSIVE` over graph-shaped data (edges, hierarchies)
  loops forever on cycles unless terminated: use the SQL-standard `CYCLE` clause
  (Postgres 14+) or carry a visited-path guard. [corpus: postgres/recursive-cycle]

## RLS testing doctrine

The `schema-rls` gate proves policies **exist**; the runtime suite proves they
**isolate**. `node tests/rls/run-rls.mjs` (the `rls-isolation` Stop-hook step /
`pnpm test:rls`) orchestrates, each layer independently guarded:

1. Resolve DSNs (env wins; otherwise passwordless local-dev defaults derived from
   docker-compose.yml — trust auth on 127.0.0.1 only, no credentials to leak).
2. Probe Postgres (3s timeout). Unreachable → loud SKIP locally; **in CI with
   migrations present, unreachable = FAIL** (the runtime job provides a database; a
   skip there would false-green the headline isolation gate).
3. Reachable → fresh-apply all migrations, then run the vitest suite with
   `RLS_SUITE_READY=1`. The suite ALWAYS runs and self-skips politely when not ready;
   its exit code is the gate. Never hangs, never false-greens a real leak.

The suite (`tests/rls/cross-tenant-isolation.test.ts` over `db-context.ts`) asserts,
per `ISOLATION_TARGETS` entry:

- **Seeded positive control** — user A sees its OWN row first. Without this, a
  deny-all database (or a broken impersonation helper) would pass every negative
  assertion vacuously. The same doctrine applies to the mid-turn `rls_verify` MCP
  probe: it first proves user B self-visibility before asserting A-cannot-see-B.
- Cross-user SELECT returns **zero rows, no error**; cross-user UPDATE/DELETE match
  **0 rows**; INSERT smuggling the other user's id is rejected by WITH CHECK with
  **SQLSTATE 42501**; the victim's data is untouched afterwards.
- **GUC-leak detector** — pool `max: 1` ON PURPOSE: after an impersonated
  transaction, the SAME physical connection must have no identity
  (`current_setting('app.user_id', true)` IS NULL, RLS matches nothing). Connection
  rotation would hide exactly the session-GUC bug class this exists to catch.
- **Catalog gate** — facts from `pg_catalog`, not vibes: `relrowsecurity` AND
  `relforcerowsecurity` true, per-operation policies present, pgvector at a patched
  version, and the connected role neither superuser nor BYPASSRLS.

Tests impersonate via the same shape as the server's `withUserContext`
(`set_config('app.user_id', <uuid>, true)` in a transaction) so the suite exercises the
exact GUC discipline production uses. Add one `ISOLATION_TARGETS` entry per user-scoped
table; the matrix runs for each.

### Mid-turn RLS probe (`rls_verify`)

The local stdio MCP server `tools/mcp/rls-verify-server.mjs` gives the agent an
in-loop isolation check before the Stop gate: read-only, transaction-local GUCs, always
rolled back, positive control first, returns `RLS: ISOLATED / LEAK / SKIPPED` — anything
preventing a real probe is a SKIP, never a green. The CI suite is authoritative.

## The provenance pipeline

The chain runs **corpus → code → check → ADR → verification → gate**:

1. **Pinned corpus** — `tools/mcp/corpus/index.json` holds version-pinned entries
   (`{id, title, url, version, text, sha256}`) for every external authority the code
   relies on. `tools/mcp/corpus-search-server.mjs` serves it as the `corpus_search` MCP
   tool for mid-turn grounding — no network, reads only the local corpus (**writing
   tools for agents; corpus grounding**: tools return an honest `NO_MATCH`/`SKIPPED`
   rather than a fabricated result).
2. **In-code convention** — every non-trivial decision carries `// SOURCE: <authority>`
   (`-- SOURCE:` in SQL), with `[corpus: <id>]` when pinned.
3. **Enforcement** — `posttool-source-check.mjs` per edit; `tools/check-sources.mjs`
   (the `provenance` gate) over the whole tree in validate/CI.
4. **`/adr`** — one ADR per slice into `docs/adr/`, its **Sources** section reconciled
   against every inline `// SOURCE:` in the slice (each must appear in the other).
5. **`/verify-citations`** — the read-only `citation-verifier` subagent resolves each
   citation for **existence** and **support**, returning `CITATIONS: CLEAN` or
   `CITATIONS: REJECTED`. A turn does not end with rejected citations. Both failure
   classes (unresolvable; resolvable-but-unsupporting) are documented LLM failure modes
   — the verifier re-checks rather than trusting self-report.

## The validate contract

- **Done means green gate.** A turn is not finished until `pnpm validate` and the
  Stop-hook runtime suites pass. Do not summarize a red build as "mostly working".
- **Prove, don't claim.** The gate output is the evidence.
- **No same-turn test edits.** Deliberately a **review-time rule** (AGENTS.md contract +
  reviewer subagents + PR review), not a hook: a legitimate feature adds code and tests
  together, and a deterministic ban cannot tell the two apart (see the rejected-gates
  list in the [gates catalog](./gates-catalog.md)).

### Spec-first SOP

For any change touching auth, RLS, migrations, the Tauri security surface
(capabilities/CSP), or the API contract: write `specs/<feature>.md` (from
`specs/_template.md`), get human sign-off, **then** implement — ideally in a fresh
session. The spec is necessary but not sufficient; the gate holds the line either way.

## Adversarial review

Reviewer subagents are **read-only by construction** — `Read, Grep, Glob` only, so a
prompt-injected reviewer cannot become a writer. `citation-verifier` additionally holds
`WebFetch` (allow-listed documentation domains) + `corpus_search`, but still no write or
shell tool.

- `security-reviewer` — MUST run on any change to RLS SQL, the DAL/`withUserContext`,
  auth verification, capabilities, or the CSP.
- `torvalds-reviewer` — the quality red-team (data structures first, kill special
  cases, delete code) before a slice is declared done.
- `citation-verifier` — the provenance verifier above.
- `accessibility-reviewer` — keyboard/WCAG review on UI-heavy slices.

## Gate mechanism notes

Ground truth is each script; this is the *why*. Full per-gate reference (including
anti-vacuity proofs) in the [gates catalog](./gates-catalog.md).

- **tauri-policy gate** (`tools/check-tauri-policy.mjs`) — pure-JSON asserts over the
  committed Tauri security surface: isolation pattern on; CSP non-null with
  `default-src 'self'`, a `connect-src`, and no `unsafe-eval`; no `dangerous*` keys
  anywhere; bundle identifier matches `tools/identity.lock.json` (installer upgrade
  identity must never drift after first release); WebView2 install mode stays
  `offlineInstaller` (enterprise/offline invariant — the bootstrapper silently fails on
  egress-restricted machines); capabilities grant no remote IPC, no shell/process
  execution, no `**` fs scopes. No cargo, no network, <100ms.
- **version-sync gate** (`tools/check-version-sync.mjs`) — one version everywhere: root
  package.json = tauri.conf.json = apps/server = apps/desktop (the skew middleware
  compares `x-client-version` majors — a drifted manifest makes the desktop lie about
  itself); `.nvmrc`/`.node-version`/`engines.node` agree; rc-churn tools
  (babel react-compiler plugin, drizzle-kit, tauri CLI) EXACT-pinned in the catalog;
  zod resolves to exactly one version (two instances break `instanceof` across
  the OpenAPI layer with incomprehensible errors).
- **prompt versioning** (`tools/check-prompts-lock.mjs`) — every LLM prompt under
  `packages/*/prompts/` or `apps/*/prompts/` must be hash-locked in
  `tools/prompts.lock.json` and carry a `.vN` version in its filename. A changed prompt
  without a lock update silently changes model behavior with no eval trail; the lock is
  write-guard-protected so updating it is a deliberate act.
- **license gate** (`tools/check-licenses.mjs`) — the production npm dependency tree
  stays inside a permissive allowlist, so the Stop gate itself refuses a
  copyleft/unknown-license dependency the moment an agent adds one. Exceptions are
  reviewable data in `tools/license-exceptions.json`. Rust crates are covered by
  cargo-deny (`deny.toml`) in the CI rust lane.
- **schema-rls gate** (`tools/check-rls-manifest.mjs`) — static <100ms cross-reference:
  every Drizzle `pgTable` must have ENABLE + FORCE ROW LEVEL SECURITY and per-operation
  policies somewhere in the cumulative migration SQL, or an entry in the human-reviewed
  `tools/rls-exempt.json`. A new table cannot land without its RLS story; the runtime
  suite proves the policies actually isolate.
- **contracts gate** (`tools/check-contract-drift.mjs`) — (1) OpenAPI regen-diff: re-emit
  from the live route definitions (stable-stringified) and diff against the committed
  `apps/server/openapi.json`; (2) tsconfig project references must mirror the pnpm
  workspace dependency graph — three parallel topologies (workspace deps, project refs,
  knip map) desynchronize into confusing type errors otherwise.
- **rust gates; stamp** (`tools/run-rust-gates.mjs`) — `rust-fmt` = `cargo fmt --check`
  (seconds, whenever cargo exists). `rust-check` = `cargo check --locked` + tauri-specta
  bindings drift (regenerate `src/ipc/bindings.ts`; any git diff = stale committed
  bindings), gated by a content-hash stamp (`.harness/rust-check.ok` = sha256 over
  src-tauri sources + Cargo.lock) so an unchanged Rust tree is an instant OK locally and
  the Stop hook stays fast. CI ignores the stamp (fail closed, full run); clippy
  `-D warnings` runs in the CI rust lane.
- **build gate; desktop-bundle purity** (`tools/build-check.mjs`) — the SPA must
  actually `vite build`, and the emitted `dist/` must be PURE: no ORM markers, no
  privileged DSN names, no connection strings, no signing-material references. Bundle
  purity is the runtime backstop for the depcruise/lint walls — a transitive import that
  sneaks past static analysis still shows up in the emitted JS.

## Stop-hook cost (and how to trim it)

`STOP_HOOK_STEPS` ends with the runtime suites; the expensive validate steps are `build`
(vite build + bundle grep) and `rust-check` (first run after a Rust change; the stamp
makes unchanged-Rust turns instant). To trade turn-end latency for CI-time discovery, a
HUMAN can comment steps out of `tools/harness.config.mjs` (harness-protected —
`HARNESS_ALLOW_SELF_EDIT=1`); CI still enforces the hardcoded floor via `--min-floor`,
so nothing is lost on the PR, only discovered later. Keep `build` in while doing
desktop-heavy work; the feedback loop is worth the seconds. Opt-in gate modules are
enabled the same way (see the [gates catalog](./gates-catalog.md)).

## The lethal-trifecta posture

An agent is dangerous when it combines (1) access to private data, (2) exposure to
untrusted content, and (3) the ability to communicate externally. Break at least one leg
for any agent that touches real data (see `docs/security/sandbox-and-supply-chain.md`):

- **No standing exfiltration** — Bash network commands denied; `WebFetch` allow-listed
  to a small set of documentation domains.
- **No privileged-role exposure** — `MIGRATOR_DATABASE_URL` is confined to
  drizzle-kit/migration-tests (bash-guard); signing keys exist only in CI secrets; the
  app role is provably non-BYPASSRLS (catalog gate). RLS is the backstop.
- **Read-only reviewers** — the subagents most exposed to untrusted content cannot
  write or execute.
- **Default-deny tooling** — no MCP server or Skill runs unless registered in
  `docs/security/approved-tools.md`, version-pinned and reviewed.

## Statusline

- **statusline surfaces gate state** (`.claude/statusline.mjs`) — renders
  `model | branch±dirty | gate: pnpm validate`: a standing reminder of the gate command
  (a live `pnpm validate` per render would be too slow).

## Threat model / honest limits

What this harness claims, precisely:

- **Tamper-evident, not tamper-proof.** Shell access can modify anything; the design
  makes tampering visible (explicit override env var, manifest drift, PR diff) and
  non-load-bearing (CI floor + CODEOWNERS decide what merges).
- **Guards are tripwires, not sandboxes.** Regex guards catch the common dangerous
  forms; obfuscation can evade them. The permission deny list, the read-only reviewer
  construction, and CI are the layers that do not depend on pattern-matching.
- **RLS is the data boundary; everything client-side is UX.** A compromised desktop
  binary or webview can send any request it likes — it still authenticates as one user
  and FORCE RLS bounds the blast radius to that user's rows.
- **Skips are visible by design.** Any gate that could not run says so loudly and fails
  closed in CI; treat a `SKIPPED` line in local output as work remaining, not as green.
