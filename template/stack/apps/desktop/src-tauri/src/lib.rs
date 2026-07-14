//! Tauri host shell: logging, the typed IPC surface, and lifecycle logging.
//!
//! The host holds NO privileged business authority: capabilities gate which
//! WINDOW may call a command, not which USER may perform an action — all real
//! authorization lives in the API server behind Postgres FORCE RLS.
// SOURCE: Tauri 2 security model — the IPC/capability layer is not an
// authorization boundary [corpus: tauri/capabilities]

use std::sync::OnceLock;
use std::time::Instant;
use tauri_specta::{collect_commands, Builder};

/// Monotonic clock started as the host enters `run()` — the anchor for the
/// cold-start budget.
///
/// HONEST LIMIT — this is not process spawn. Rust does effectively no pre-main
/// work, so the gap is microseconds of std init, but it cannot see the OS loader
/// (mapping the exe, resolving `WebView2`). That part is only visible from outside
/// the process, which is why the nightly real-binary lane brackets this number
/// with its own wall-clock envelope rather than trusting it alone.
static BOOT: OnceLock<Instant> = OnceLock::new();

/// Host (crate) version. The version-sync gate keeps this crate,
/// `tauri.conf.json`, and the workspace package versions in lockstep.
#[tauri::command]
#[specta::specta]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Milliseconds from host start to now.
///
/// The webview stamps this onto `<html data-boot-ms>` at first paint, which is what
/// makes cold-start TTI measurable AT ALL: the host owns the process clock and the
/// webview owns "interactive", and neither half can see the other. The real-binary
/// lane reads the attribute and budgets it.
///
/// `u32` (not `u64`) deliberately: specta's default bigint policy REFUSES to export a
/// 64-bit integer to TypeScript rather than silently truncate it through `number`, so a
/// `u64` here would fail the bindings export. Milliseconds fit in `u32` for 49 days of
/// uptime, and a boot that took 49 days has a bigger problem than a saturated counter.
///
/// Returns 0 before `run()` has started the clock (unit tests, benches) — not a boot.
#[tauri::command]
#[specta::specta]
fn boot_elapsed_ms() -> u32 {
    BOOT.get().map_or(0, |started| {
        u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
    })
}

/// The bearer token the API server authenticates the user with.
///
/// It lives in the HOST, never in the webview: a `VITE_`-prefixed token would be
/// compiled into the shipped client bundle (the write-guard bans the very name), and
/// a token in webview storage is reachable by any injected script. The webview asks
/// for it over typed IPC and attaches it per request (`src/lib/api-client.ts`).
///
/// HONEST LIMIT — this reads the token the host was started with. Acquiring it is the
/// project seam: a real deployment runs the Entra (MSAL) authorization-code + PKCE flow
/// here and caches the result in the OS keychain, refreshing before expiry. The scaffold
/// ships the dev path (stub-mode token minted by `scripts/mint-dev-token.mjs`) so the
/// desktop↔server auth seam is EXERCISED end-to-end by a real gate rather than assumed.
/// `None` means unauthenticated — the client surfaces it, it never sends a bare request.
// SOURCE: Tauri 2 security model — the webview is untrusted; secrets stay host-side
// [corpus: tauri/capabilities]
#[tauri::command]
#[specta::specta]
fn access_token() -> Option<String> {
    std::env::var("APP_ACCESS_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
}

/// Structured-log contract for webview render-process failures.
///
/// As of tauri 2.11 the safe API surface does NOT expose `WebView2`'s
/// `ProcessFailed` (verified against 2.11.5 docs: `tauri::WebviewEvent` has
/// only `DragDrop`, and `RunEvent` has no crash variant). Wiring the real
/// handler needs `Webview::with_webview` + the `webview2-com` crate's
/// `add_ProcessFailed` — unsafe COM interop that belongs to the
/// crash-reporting module, not this `unsafe_code = "forbid"` base host.
/// That module must call THIS function, so the log shape is stable today and
/// renderer crashes never ship as invisible blank-window tickets.
// SOURCE: WebView2 ProcessFailed handling doctrine [corpus: tauri/webview-process-failed]
pub fn log_webview_process_failure(webview_label: &str, detail: &str) {
    log::error!(
        target: "app::webview",
        "webview_process_failed label={webview_label} detail={detail}"
    );
}

/// The single source of truth for the typed IPC surface: every `#[tauri::command]`
/// is registered here, and BOTH the runtime invoke handler and the exported
/// TypeScript bindings derive from it — they cannot drift from each other.
///
/// Generic over the runtime so `benches/host.rs` can mount this EXACT command set on
/// tauri's mock runtime. A bench that registered its own lookalike handler would
/// measure a fiction.
fn specta_builder<R: tauri::Runtime>() -> Builder<R> {
    Builder::<R>::new().commands(collect_commands![
        app_version,
        access_token,
        boot_elapsed_ms
    ])
}

/// The logging plugin, exactly as the shipped app configures it.
#[must_use]
pub fn logging() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::new().level(log::LevelFilter::Info)
}

/// The builder chain the app actually boots through: the log plugin, the typed invoke
/// handler, and the setup hook.
///
/// Factored out (and generic over the runtime) so the criterion boot bench drives THIS
/// code and not a copy of it — `benches/host.rs` builds an app through this exact function
/// on tauri's mock runtime, so a blocking call added to `.setup()` reds the `native-perf`
/// gate in a blocking lane instead of shipping as a slower cold start that no machine check
/// ever looks at.
///
/// `logging` is a PARAMETER for one reason, and it is the honest seam in this design: the
/// plugin's init calls `log::set_boxed_logger`, which by construction can only succeed once
/// per process, and on the way there it also builds the fern dispatch and OPENS THE ROTATING
/// LOG FILE. A bench boots the app thousands of times in one process, so it must pass
/// `logging().skip_logger()` — it could not do otherwise, and it should not want to: that
/// work is third-party, disk-bound and once-per-process, and folding it into every sample
/// would swamp the signal from the `.setup()` body this project actually owns. The
/// everything-included number is the job of the real-binary cold-start budget (nightly,
/// `data-boot-ms`), which is why both legs exist.
#[must_use]
pub fn configure_app<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    logging: tauri_plugin_log::Builder,
) -> tauri::Builder<R> {
    let specta_builder = specta_builder::<R>();

    builder
        .plugin(logging.build())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
}

/// Builds and runs the tauri application.
pub fn run() {
    // First statement in the process: everything after this is inside the measured
    // cold-start window that `boot_elapsed_ms` reports and the real-binary lane budgets.
    BOOT.get_or_init(Instant::now);

    // Debug builds re-export the committed TS bindings on boot; the CI rust
    // lane recompiles and fails on drift from the Rust signatures.
    // SOURCE: tauri-specta v2 committed-bindings doctrine [corpus: tauri/specta-bindings]
    #[cfg(debug_assertions)]
    export_bindings(&specta_builder::<tauri::Wry>());

    let app = configure_app(tauri::Builder::default(), logging())
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            // Pre-window failure: the log plugin may not be mounted yet, but a
            // no-op log line is still better than a banned stderr print.
            log::error!(target: "app::lifecycle", "failed to build tauri app: {error}");
            std::process::exit(1)
        });

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            log::info!(target: "app::lifecycle", "window destroyed label={label}");
        }
        tauri::RunEvent::Exit => {
            log::info!(target: "app::lifecycle", "event loop exit");
        }
        _ => {}
    });
}

#[cfg(debug_assertions)]
#[allow(clippy::expect_used)] // dev-only: a silent export failure would ship drifted IPC bindings
fn export_bindings(builder: &Builder<tauri::Wry>) {
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/ipc/bindings.ts",
        )
        .expect("failed to export TypeScript bindings to ../src/ipc/bindings.ts");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regenerates `../src/ipc/bindings.ts` from the Rust command signatures.
    /// The rust-check gate runs `cargo test export_bindings` and then fails on
    /// any git diff — when the IPC surface changes, commit the regenerated file.
    // SOURCE: tauri-specta v2 committed-bindings doctrine [corpus: tauri/specta-bindings]
    #[test]
    #[allow(clippy::expect_used)] // test-only: a silent export failure would ship drifted IPC bindings
    fn export_bindings() {
        specta_builder::<tauri::Wry>()
            .export(
                specta_typescript::Typescript::default(),
                "../src/ipc/bindings.ts",
            )
            .expect("failed to export TypeScript bindings to ../src/ipc/bindings.ts");
    }
}
