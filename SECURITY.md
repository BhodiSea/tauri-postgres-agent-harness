# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/BhodiSea/tauri-postgres-agent-harness/security/advisories/new).
Do not open public issues for security reports, and never include live
credentials (database DSNs, Entra client secrets, Windows code-signing
material, Tauri updater private keys) in a report.

## Supported versions

The latest tagged release and `main` are supported. Installed projects should
run `npx --yes github:BhodiSea/tauri-postgres-agent-harness update` to pick up
fixes.

## Scope notes

- The harness's guard hooks and permission denies are **tamper-evident, not
  tamper-proof**: a determined agent with shell access can bypass local
  enforcement. CI parity (`tools/validate.mjs --min-floor`), manifest hashing
  (`doctor`), and CODEOWNERS review are the backstops. Reports that "the agent
  can edit its own gate with `HARNESS_ALLOW_SELF_EDIT=1`" describe the
  documented human escape hatch, not a vulnerability.
- Template workflows are stored dotless under `template/` precisely so they
  can never execute in this repository's own Actions context.
- The scaffolded stack's authorization boundary is the server-only DAL over
  Postgres FORCE RLS. Tauri capabilities/IPC and any client-side check are
  defense-in-depth only; reports demonstrating "the desktop client can call an
  API it shouldn't render UI for" must show the DAL/RLS layer failing, not the
  client hiding a button.
