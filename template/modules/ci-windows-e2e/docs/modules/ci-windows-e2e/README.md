# Module: ci-windows-e2e

Real-binary end-to-end tests on Windows: tauri-driver + WebdriverIO drive the
DEBUG exe through its actual WebView2, nightly + on demand. This lane covers what
the fast Playwright lane structurally cannot: the isolation pattern, the enforced
CSP, host IPC, and the enterprise-network failure modes —

- **TLS-inspecting proxy** (mitmproxy CA in the MACHINE certificate store): the app
  must keep working behind enterprise middleboxes. `deny.toml` already bans
  `webpki-roots` so the platform trust store is honored.
- **Redirected APPDATA at a >280-char path**: enterprises redirect profiles to
  deep UNC/DFS trees; `build.rs` sets `longPathAware` and this run proves it.
- **WebView2 kill/recover**: the renderer is crashed mid-session; the host's
  `ProcessFailed` handler must recover instead of leaving a dead window.

## What it adds

| File | Purpose |
| --- | --- |
| `.github/workflows/e2e-windows.yml` | nightly/dispatch Windows lane (smoke + tls-inspection jobs) |
| `e2e-windows/wdio.conf.ts` | WDIO config pointing tauri-driver at the debug exe |
| `e2e-windows/smoke.e2e.ts` | shell smoke + landmark + status-region + kill/recover spec |
| `e2e-windows/coldstart.e2e.ts` | cold-start TTI against the real binary, budgeted (0.1.6) |
| `e2e-windows/tsconfig.json` | standalone project so the specs get typed strict lint |

## Prerequisites

- Windows runner budget (GitHub-hosted `windows-latest` works).
- Nothing else to enable: CI installs `tauri-driver` (pinned) and a
  version-matched `msedgedriver`, and fetches the WDIO toolchain via
  `pnpm dlx` (pinned majors).
- **Durable local setup (recommended once you extend the specs):**
  `pnpm add -D -w @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter @wdio/globals tsx`
  then replace the ambient declarations in the spec/config with `@wdio/types` /
  `@wdio/globals` imports and switch the workflow step to `pnpm exec wdio run`.

## How enabling works

```
npx tauri-postgres-agent-harness enable ci-windows-e2e
```

copies the files and records them in `.harness/manifest.json`. The workflow is
live immediately (nightly cron + `workflow_dispatch`) — the workflow IS the gate;
no `tools/harness.config.mjs` change.

## How this gate can FAIL (anti-vacuity)

- **smoke**: rename the window `<header>` element (or break `src/main.tsx` mounting)
  → the landmark spec fails. Change `productName` → the title assert fails.
- **long paths**: remove `longPathAware` from the app manifest wired in `build.rs`
  → file IO under the redirected APPDATA breaks.
- **kill/recover**: stub the `ProcessFailed` handler out of `src-tauri/src/lib.rs`
  → the post-kill `getTitle()` probe times out.
- **tls-inspection**: skip the `certutil -addstore` step in a scratch branch → the
  proxied HTTPS probe fails with an untrusted-chain error, proving the job really
  exercises the machine trust store.
- **cold-start**: put a blocking op in the boot path (a sync network call in
  `.setup()`, a heavy import before first paint) → `data-boot-ms` exceeds
  `tools/native-perf-budget.json#coldStart.maxBootMs` and the spec fails. Delete the
  `stampBootTiming()` call from `src/main.tsx` → the attribute never appears and the
  spec fails on the ABSENT measurement rather than passing on a missing number.

## Honest limits

- The mitmproxy job currently proves the interception chain with a PowerShell
  probe; the marked `TODO(project)` closes the loop by launching the app under
  `HTTPS_PROXY` against your staging API.
- WDIO runs single-instance (`maxInstances: 1`) — WebDriver sessions against a
  desktop app do not parallelize safely.
- **Cold-start TTI is a MONITOR, not a merge gate.** It is wall-clock on a shared
  Windows runner and this lane is nightly, so it catches step-functions (a blocking
  call in boot), not slow drift, and it cannot block a PR. The per-PR *deterministic*
  native floor is the criterion bench in the `rust` job of `quality-gate.yml`
  (`tools/check-native-perf.mjs`), whose budgets are ratios rather than wall-clock and
  which therefore survives a noisy runner. The two are complementary: criterion is
  sensitive but blind to the OS loader, WebView2 and React; this sees all of them but
  only coarsely.
