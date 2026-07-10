# Module: ci-provenance

Supply-chain evidence for what you ship: SLSA Build L2 provenance attestations for
`npm pack`ed workspace packages, SBOMs for BOTH ecosystems (syft/SPDX for npm,
cargo-cyclonedx for the Rust host crate), an in-CI `gh attestation verify` gate,
and a NOTICES drift check that keeps third-party attributions honest.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/provenance.yml` | tag-triggered attest + dual SBOM + verify pipeline |
| `tools/check-notices.mjs` | regenerates NOTICES.md from the live prod dependency set; fails on drift |

## Prerequisites

- Nothing secret: attestation uses GitHub OIDC (`id-token: write`) — no keys to manage.
- One-time: `node tools/check-notices.mjs --write` to create the initial
  `NOTICES.md`, review it, commit it. Until then the notices gate fails loudly
  (that first failure is the anti-vacuity proof — see below).

## How enabling works

```
npx tauri-postgres-agent-harness enable ci-provenance
```

copies the files; the workflow runs on the next `v*` tag (or `workflow_dispatch`).
The workflow IS the gate — no `tools/harness.config.mjs` change. This module is
part of the `standard` tier.

## How this gate can FAIL (anti-vacuity)

- **notices**: enable the module and run the workflow BEFORE writing NOTICES.md →
  fails with the `--write` hint. After committing it, `pnpm add` any prod
  dependency without regenerating → fails on drift.
- **attest/verify**: revoke `id-token: write` in a scratch branch → the attest
  step fails; or verify a tampered tarball locally
  (`gh attestation verify <modified>.tgz -R <org>/<repo>`) → verification fails.
- **crates SBOM**: point `--manifest-path` at a missing Cargo.toml → fails.

## Honest limits

- SLSA **L2**, not L3: a valid attestation proves the artifact came out of this
  workflow — it does NOT prove the source was untampered (a stolen OIDC token
  mints valid attestations). L3 needs the isolated slsa-github-generator build.
- The Windows installer itself is attested where it is built: extend
  `release-windows.yml` (ci-windows-release) with the same attest/verify pair if
  your consumers verify the .exe rather than the packages.
