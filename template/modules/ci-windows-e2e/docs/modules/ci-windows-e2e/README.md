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

## Honest limits

- The mitmproxy job currently proves the interception chain with a PowerShell
  probe; the marked `TODO(project)` closes the loop by launching the app under
  `HTTPS_PROXY` against your staging API.
- WDIO runs single-instance (`maxInstances: 1`) — WebDriver sessions against a
  desktop app do not parallelize safely.
