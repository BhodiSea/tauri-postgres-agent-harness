# Patch: desktop crash reporting (Tauri + self-hosted Sentry)

OPT-IN wiring for `apps/desktop` + the Rust host. Copy deliberately; nothing is
applied automatically. Two distinct crash surfaces exist on the desktop:

1. **Webview JS errors** — window `error` / `unhandledrejection` events.
2. **Rust host panics + native crashes** — the `sentry` Rust crate (panics) and,
   if you need native minidumps, its crashpad feature.

## 1. Webview side (no SDK required to start)

The scaffold's IPC facade is the right funnel: forward webview errors to the host
over a typed command and let the HOST decide about network egress — the webview's
CSP (`connect-src`) stays pinned to `{{API_ORIGIN}}` and gains no Sentry host.

```ts
// apps/desktop/src/main.tsx — after mounting
window.addEventListener('error', (event) => {
  void commands.reportCrash({ message: String(event.message), stack: event.error instanceof Error ? (event.error.stack ?? '') : '' })
})
window.addEventListener('unhandledrejection', (event) => {
  void commands.reportCrash({ message: String(event.reason), stack: '' })
})
```

Add the matching `#[tauri::command] fn report_crash(...)` in
`src-tauri/src/lib.rs`, regenerate the specta bindings (`cargo test
export_bindings`), and commit them — the rust-check gate enforces the drift.

## 2. Rust host side

```toml
# apps/desktop/src-tauri/Cargo.toml
sentry = { version = "0", default-features = false, features = ["backtrace", "contexts", "panic", "reqwest", "rustls"] }
```

Note `rustls` + platform verifier alignment: never a feature set that bundles
Mozilla roots (`deny.toml` bans webpki-roots — enterprise TLS interception must
keep working).

Initialize in `main.rs` behind an env/config flag, defaulting OFF. Route BOTH
funnels (forwarded webview errors + host panics) through a Rust port of the same
redaction policy as `apps/server/src/crash/redact.ts` — port the regexes 1:1 and
port `redact.test.ts` alongside them (`#[cfg(test)]`), so both languages enforce
the identical policy.

## 3. Symbols / PDBs (release lane)

Windows release builds strip debug info. For readable native stacks, add to the
ci-windows-release workflow, AFTER the build and BEFORE signing:

```yaml
- name: Upload PDBs to self-hosted Sentry
  if: env.HAVE_SIGNING == 'true'
  run: pnpm dlx @sentry/cli@2 debug-files upload --include-sources apps/desktop/src-tauri/target/release/
  env:
    SENTRY_URL: ${{ secrets.SENTRY_URL }}
    SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
    SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
    SENTRY_PROJECT: desktop
```

Gate the release on the upload succeeding — a crash you cannot symbolicate is a
crash you will misdiagnose.

## 4. Diagnostics bundle (user-triggered, offline-friendly)

For deployments where outbound crash reporting is banned outright, keep the
transport OFF and wire a "Save diagnostics bundle…" menu action instead: collect
the tauri-plugin-log file + redacted recent events into a zip the user hands to
support. Same redaction boundary; zero network egress; the user stays in control.
