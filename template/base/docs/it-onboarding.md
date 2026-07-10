# IT onboarding — deploying {{PROJECT_NAME}} on a managed Windows fleet

Audience: enterprise IT / endpoint engineering. What this document covers: everything
needed to package, allow-list, and silently deploy the {{PROJECT_NAME}} desktop client
(`.exe`, NSIS installer) via Intune/SCCM/GPO on locked-down, proxied, or air-gapped
Windows estates. Update this file whenever the app version bumps; the release pipeline
attaches a SHA-256 checksum manifest per release.

## What the app is

- A Tauri 2 desktop application: a native host process plus Microsoft **WebView2**
  (Evergreen runtime) rendering the UI. Publisher: **{{WINDOWS_PUBLISHER}}**. Bundle
  identifier: `{{PRODUCT_IDENTIFIER}}` (stable across all releases — safe to key
  rules on).
- Network surface: the app talks ONLY to your on-prem API at `{{API_ORIGIN}}`
  (pinned in the app's Content-Security-Policy `connect-src` at build time). No
  telemetry, no vendor cloud, no CDN dependency at runtime.

## Code signing & SmartScreen

- Every shipped binary and the installer are Authenticode-signed with an RFC 3161
  timestamp (Azure Trusted Signing in CI; short-lived certificates stay valid
  indefinitely once timestamped). Verify before distribution:
  `signtool verify /pa /all <installer.exe>`.
- SmartScreen reputation keys on the durable publisher identity. For internal
  deployment, do not wait for public reputation: deploy through managed channels and
  pre-clear the binary (below). AppLocker/WDAC **publisher rules** should target the
  signing subject — and must cover both the app executable AND
  `msedgewebview2.exe` (the WebView2 runtime the app spawns).

## WebView2 runtime (offline installer — no egress needed)

- The installer embeds the WebView2 **offline/standalone installer** (~127 MB;
  `webviewInstallMode: offlineInstaller`). Installation requires **no network
  access** — the default download-bootstrapper mode is deliberately not used because
  it silently fails on egress-filtered networks.
- If WebView2 Evergreen is already fleet-deployed, the embedded installer is skipped.
  Allow WebView2's Evergreen update mechanism (Edge Update) per your patching policy,
  or manage the runtime version centrally — the app does not pin a runtime version.
- WebView2 spawns child processes (renderer, GPU, network utility, crash handler).
  EDR policies must allow these child processes; blocking them presents as blank
  windows, freezes, or sign-in loops.

## Silent install / uninstall (NSIS)

- **Per-machine** install (`perMachine`): requires elevation, lands under
  `C:\Program Files\`, registers in Add/Remove Programs under HKLM. Chosen over
  per-user to avoid per-user AppData installer copies that roaming/VDI multiplies.
- Silent install: `installer.exe /S`
- Custom directory: `installer.exe /S /D=C:\Path\To\Install` (`/D=` must be last, no
  quotes).
- Silent uninstall: run the registered uninstaller with `/S` (Add/Remove Programs →
  QuietUninstallString).
- Upgrades: install the new version over the old one silently; upgrade identity is
  keyed to `{{PRODUCT_IDENTIFIER}}` and never changes.

## TLS-inspecting proxies & private CAs

- **The webview uses the Windows certificate store and WinINET proxy settings.** All
  interactive app traffic (API calls, streaming) goes through WebView2's Chromium
  network stack, so it: trusts your private root CA if it is in the LocalMachine
  Root store (standard Zscaler/Palo Alto TLS-inspection setups work with zero app
  config), evaluates PAC files, and performs NTLM/Kerberos proxy auth with SSO.
- The optional updater's Rust-side HTTP also verifies against the OS trust store
  (platform verifier) — no bundled Mozilla root list that would reject your CA.
- Escape hatch if a machine's proxy config cannot be resolved automatically: launch
  the app's webview with an explicit proxy via Tauri's `additionalBrowserArgs`
  (`--proxy-server=...`) — coordinate with the application team.
- TLS-inspection proxies that kill long-lived streaming connections are tolerated:
  the app detects dead streams and resumes; no allow-list entry is required, though
  bypassing inspection for `{{API_ORIGIN}}` reduces latency.

## EDR / AV allowlisting

- Pre-clear each release: the release pipeline scans artifacts with Microsoft
  Defender before publishing, and ships a SHA-256 manifest suitable for Defender for
  Endpoint allow-indicators. For false positives, submit via the Microsoft Security
  Intelligence portal ("Software developer — false positive").
- Prefer **publisher-based** AppLocker/WDAC rules over hash rules (hashes change
  every release; the signing identity does not).
- Do **not** inject DLLs into WebView2 processes, tighten ACLs on the WebView2
  runtime or its user-data folder, or block its child processes — these are the
  documented causes of blank screens and crashes. Use scoped (never global) AV
  exclusions if scanning the WebView2 cache tree causes performance issues.

## Data directories, VDI/FSLogix, long paths

- Heavy mutable state (caches, logs, the WebView2 user-data folder `EBWebView`)
  lives under `%LocalAppData%\{{PRODUCT_IDENTIFIER}}` — local-only by design. Only
  small preference files use Roaming AppData. Do not redirect the local data dir to
  a UNC share; the app refuses remote filesystems for its database/cache rather than
  corrupting silently.
- FSLogix: exclude the `EBWebView` cache tree from profile containers (it bloats
  containers and is safe to discard).
- The executable embeds a `longPathAware` manifest. It only takes effect if the
  fleet GPO enables long paths (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`
  → `LongPathsEnabled=1`) — recommended for redirected-profile estates where
  `MAX_PATH` overflows surface as spurious file-not-found errors.

## No-egress posture (air-gapped friendly)

- Zero internet dependency: install is offline (embedded WebView2), runtime traffic
  is exclusively `{{API_ORIGIN}}` on your network, and updates arrive through your
  own deployment channel (Intune/SCCM) — the self-updater build flavor, if used,
  points only at an on-prem HTTPS endpoint you host.
- Firewall rule of thumb: allow the app + `msedgewebview2.exe` outbound to
  `{{API_ORIGIN}}` only. Nothing else is required for full functionality.

## Clock skew

- API authentication tolerates ±5 minutes of client/server clock skew (aligned with
  the Kerberos/AD default). Machines drifting beyond that (common on non-persistent
  VDI images before w32time converges) will see a "check this machine's clock" error
  rather than a generic auth failure.

## Checklist (per release)

1. `signtool verify /pa /all` on installer + exe — signed, timestamped.
2. Compare artifact hashes against the release's SHA-256 manifest.
3. Defender/EDR pre-clearance recorded; publisher rules in place (app + WebView2).
4. Silent-install pilot on one managed image: `/S`, verify Program Files placement,
   ARP entry, app launch, API reachability through the production proxy.
5. Silent-uninstall pilot: clean removal, no orphaned services or startup entries.
