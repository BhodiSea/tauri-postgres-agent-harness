# Module: ci-windows-release

The signed Windows release DAG. Tag-triggered (`v*`): NSIS build → Azure Trusted
Signing → `signtool verify /pa /all` → silent `/S` install/uninstall smoke →
Windows Defender scan → installer size budget → SHA-256 checksums → attach to the
GitHub release. Plus release-please automation that maintains the release PR and
bumps every version surface in lockstep (the `version-sync` gate requires it).

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/release-windows.yml` | the tag-triggered build/sign/verify/smoke pipeline |
| `.github/workflows/release-please.yml` | conventional-commit release automation |
| `release-please-config.json` / `release-please-manifest.json` | version-bump config: root + apps/desktop + apps/server + tauri.conf.json move together |

## Prerequisites

- A GitHub environment named `release` (recommended: protect it with required reviewers).
- Azure Trusted Signing secrets on that environment — `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`,
  `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE_NAME`.
- Conventional commits on `{{DEFAULT_BRANCH}}` (commitlint already enforces this).

**Honest degrade:** with no signing secrets the pipeline still builds, smokes,
scans, and uploads — but writes `UNSIGNED-BUILD.txt` beside the artifact, emits a
workflow warning, and skips `signtool verify` rather than faking it. Unsigned
artifacts are for internal testing only.

## How enabling works

```
npx tauri-postgres-agent-harness enable ci-windows-release
```

copies the files above and records them in `.harness/manifest.json`. The workflow
is live on the next `v*` tag — no gate-config change needed (the workflow IS the
gate). First release: merge the release-please PR it opens after your first
conventional commit, or push a `v0.1.0` tag manually.

## How this gate can FAIL (anti-vacuity)

A release gate you have never seen fail is a decoration. Each check has a cheap
injection:

- **signature verify**: point `AZURE_CERT_PROFILE_NAME` at a nonexistent profile →
  the signing step errors; or sign nothing (unset one secret) and confirm the run
  is labeled UNSIGNED, not green-and-silent.
- **install smoke**: change `productName` in `tauri.conf.json` without updating the
  expected install dir → the smoke step fails on the missing directory.
- **size budget**: set `INSTALLER_SIZE_BUDGET_MB: 1` → fails with the measured size.
- **Defender**: not directly injectable (do NOT commit an EICAR file — push
  protection will rightly stop you); the step fails closed on `MpCmdRun` exit code 2.
- **checksums/upload**: delete the bundle glob path → `if-no-files-found: error` trips.

## Notes

- The identity in `tools/identity.lock.json` pins `PRODUCT_IDENTIFIER`; changing it
  after the first release breaks NSIS/MSI upgrade identity. The `tauri-policy` gate
  guards this.
- Pair with the `ci-provenance` module for SLSA attestation + SBOM of what this
  pipeline ships.
