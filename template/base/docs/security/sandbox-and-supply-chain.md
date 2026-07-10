# Sandbox posture & the lethal trifecta

SOURCE: docs/harness/README.md (lethal-trifecta posture; Simon Willison's "lethal
trifecta", June 2025).

## The lethal trifecta

An agent is dangerous when it combines all three of:

1. **Access to private data** (user rows, tokens, signing material), and
2. **Exposure to untrusted content** (web docs, user-supplied content, GitHub issues), and
3. **The ability to externally communicate** (Bash, network, opening PRs).

If an agent has all three, an attacker can trick it into exfiltrating private data.
**Break at least one leg** for any agent that touches private data.

## How this repo breaks the trifecta

- **No standing exfiltration.** `.claude/settings.json` denies `curl`/`wget`,
  force-push, hard reset, `.env*` and `.dev-auth/` reads, and ssh keys; `WebFetch` is
  allow-listed to a few documentation domains.
- **No privileged-role exposure.** `MIGRATOR_DATABASE_URL` (the RLS-bypassing schema
  owner) is confined by the bash guard to drizzle-kit migrate/generate/check and
  `tests/migrations/`; the API runs as `app_api` (NOSUPERUSER, NOBYPASSRLS — asserted
  from pg_catalog by the RLS suite). Updater signing keys exist only in CI secrets; any
  shell contact with `TAURI_SIGNING_PRIVATE_KEY` or minisign secret material is denied.
  RLS is the backstop.
- **Read-only reviewers.** `torvalds-reviewer`, `security-reviewer`,
  `accessibility-reviewer`, `citation-verifier` have `Read, Grep, Glob` only — they
  cannot write or run shell (citation-verifier adds allow-listed WebFetch +
  `corpus_search`, still no write/shell).
- **Least privilege per subagent.** Authors get write/Bash; reviewers do not. The local
  MCP servers (`corpus_search`, `rls_verify`) are network-free and read-only by design.

## Supply chain

- **Dependencies are pinned.** Versions live only in the pnpm-workspace.yaml catalog
  (rc-churn tools EXACT-pinned — enforced by the `version-sync` gate); `Cargo.lock` is
  committed and built `--locked`; Renovate owns bumps with cooldown; bulk
  `pnpm|cargo update` is bash-guard-blocked.
- **License + advisory gates.** `licenses` (npm allowlist) runs in every validate;
  cargo-deny (`deny.toml`: licenses, advisories, bans) runs in the CI rust lane;
  gitleaks runs pre-commit (lefthook, self-skipping) and over full history in CI.
- **No secret ever ships.** The build gate greps the emitted desktop bundle for
  DSNs/keys/signing markers; `.env.example` documents shape with empty values.

## Running sessions on sensitive code

- Use the built-in sandbox / a devcontainer (macOS Seatbelt, Linux bubblewrap) with no
  standing access to SSH keys, `.env`, or production DSNs.
- Reserve `--dangerously-skip-permissions` for sandboxed CI only.
- `disableBypassPermissionsMode: "disable"` is set so one developer cannot undo team rules.
- Keep Claude Code itself updated (repository-controlled-config CVEs are fixed only in
  current versions). New MCP servers / Skills must be on `approved-tools.md` (scanned,
  pinned) before first use.
