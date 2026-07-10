# Module: ci-macos

A macOS development build lane: proves the Rust host crate and the Tauri bundle
step still work on macOS, for teams whose contributors develop there. Windows
remains the release target — this lane produces an UNSIGNED, ad-hoc-signed `.app`
labeled as a development artifact, on `workflow_dispatch` only.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/build-macos.yml` | manual macOS debug build + artifact upload |

## Prerequisites

None beyond a GitHub macOS runner allowance. No signing identity, no
notarization — deliberately (see "Honest limits").

## How enabling works

```
npx tauri-postgres-agent-harness enable ci-macos
```

The workflow is live immediately; trigger it from the Actions tab. The workflow
IS the gate — no `tools/harness.config.mjs` change.

## How this gate can FAIL (anti-vacuity)

- Introduce a `cfg(target_os = "macos")` compile error in
  `apps/desktop/src-tauri/src/lib.rs` → the build step fails on macOS while the
  Linux/Windows lanes stay green — exactly the class of breakage this lane exists
  to catch.
- Point `bundle.icon` at a missing `.icns` → the bundle step fails.

## Honest limits

- **No signing/notarization**: distributing macOS builds requires an Apple
  Developer identity, hardened runtime, and notarization — an explicit product
  decision. When you make it, extend this workflow rather than bolting signing
  onto the Windows release lane.
- Dispatch-only: wire a `schedule:` trigger if macOS drift bites you between
  manual runs.
