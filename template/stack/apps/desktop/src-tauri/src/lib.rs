//! Tauri host shell: logging, the typed IPC surface, and lifecycle logging.
//!
//! The host holds NO privileged business authority: capabilities gate which
//! WINDOW may call a command, not which USER may perform an action — all real
//! authorization lives in the API server behind Postgres FORCE RLS.
// SOURCE: Tauri 2 security model — the IPC/capability layer is not an
// authorization boundary [corpus: tauri/capabilities]

use tauri_specta::{collect_commands, Builder};

/// Host (crate) version. The version-sync gate keeps this crate,
/// `tauri.conf.json`, and the workspace package versions in lockstep.
#[tauri::command]
#[specta::specta]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Structured-log contract for webview render-process failures.
///
/// As of tauri 2.11 the safe API surface does NOT expose WebView2's
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

/// Builds and runs the tauri application.
pub fn run() {
    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![app_version]);

    // Debug builds re-export the committed TS bindings on boot; the CI rust
    // lane recompiles and fails on drift from the Rust signatures.
    // SOURCE: tauri-specta v2 committed-bindings doctrine [corpus: tauri/specta-bindings]
    #[cfg(debug_assertions)]
    export_bindings(&specta_builder);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
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
