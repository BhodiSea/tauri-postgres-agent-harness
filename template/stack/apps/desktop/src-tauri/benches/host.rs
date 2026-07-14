//! Criterion benches for the Rust host: the real IPC invoke path and the real boot chain.
//!
//! Until v0.1.6 NOTHING in this harness measured the native side. The perf lane runs
//! `vite dev` against a mocked IPC bridge, so `#[tauri::command]` host cost, serde
//! round-trip and boot were invisible to every gate — a command could get 100× slower and
//! the whole board stayed green. These benches close that, and `tools/check-native-perf.mjs`
//! turns them into a budget.
//!
//! ## Why the budgets are ratios to `ipc/app_version`, and not nanoseconds
//!
//! Budgets live in `tools/native-perf-budget.json` as multiples of the `ipc/app_version`
//! bench — the NORMALIZER — never as absolute times. A shared CI runner's speed varies enough
//! run-to-run that an absolute ns budget is either flaky or so slack it catches nothing short
//! of a `thread::sleep`. The normalizer rides the same runner in the same process, so dividing
//! by it cancels most of the machine out.
//!
//! `app_version` is the normalizer because it is the CHEAPEST possible command — its body is
//! `env!("CARGO_PKG_VERSION").to_owned()`, a compile-time constant clone — so it measures the
//! bare cost of an invoke round-trip and has no reason to change when project code changes.
//!
//! This choice was measured, not assumed. The first draft normalized against a synthetic
//! FNV-1a ALU loop, on the theory that a fixed CPU workload tracks runner speed. It does not
//! track THIS workload: over six runs (alternating idle and 8-core-loaded) the FNV ratio was
//! *worse than no normalization at all* — a tight integer loop is clock- and thermal-bound,
//! while the invoke path is allocator- and memory-bound, so its noise is independent and a
//! noisy denominator merely injects variance. Measured coefficient of variation:
//!
//! | subject             | raw ns | ÷ FNV loop | ÷ `ipc/app_version` |
//! |---------------------|--------|-----------|---------------------|
//! | `boot/app_build`    | 40.0%  |    15.0%  |    **11.5%**        |
//! | `ipc/access_token`  | 27.5%  |    11.1%  |     **9.8%**        |
//! | `ipc/boot_elapsed_ms` | 28.0% |  13.7%   |    **14.3%**        |
//!
//! (On a quiet machine the same normalization lands at 0.2–0.6%; the figures above are a
//! deliberate torture test — 8 spinning cores on a laptop — and bound the worst case.)
//!
//! HONEST LIMIT — 2.5–4× better than raw is not "deterministic". The committed caps are set
//! above the worst ratio seen under that torture test, which makes this a net for regressions
//! of roughly **2× and up** — a sleep, a sync file read, a network call, an accidental O(n²) —
//! and NOT for slow drift. A flaky perf gate is worse than no perf gate, so the caps buy
//! reliability with sensitivity, and the gate prints every measured ratio so a project can
//! tighten them from its own CI history.

// Bench-only: a failed *setup* here must abort loudly rather than quietly benchmark nothing.
// The crate's deny-level panic lints exist to keep panics out of the SHIPPED binary, and a
// bench target is not shipped.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use std::hint::black_box;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/// Every `#[tauri::command]` on the host's IPC surface.
///
/// `tools/check-native-perf.mjs` parses the `#[tauri::command]` attributes out of
/// `src/lib.rs`, parses this list, and FAILS when they disagree. That closure is the whole
/// point: without it this file measures the commands that happened to exist the day it was
/// written, and the one an agent adds next week is an unmeasured host cost — which is
/// precisely how the IPC seam stayed unmeasured through v0.1.5.
const COMMANDS: &[&str] = &["app_version", "access_token", "boot_elapsed_ms"];

/// An app built through the SAME chain `run()` boots through (`app_lib::configure_app`), on
/// tauri's mock runtime. A bench that registered its own lookalike invoke handler would
/// measure a fiction no user ever executes.
///
/// `.skip_logger()` is the one documented divergence, and it is forced: the log plugin's
/// init calls `log::set_boxed_logger` (succeeds ONCE per process — the second app build
/// fails with "attempted to set a logger after the logging system was already initialized")
/// and on the way there it opens the rotating log file. A bench builds thousands of apps in
/// one process, so it cannot re-run that; and it should not want to, because per-iteration
/// disk I/O for a third-party once-per-process cost would swamp the signal from the
/// `.setup()` body this crate owns. What is excluded is measured instead by the real-binary
/// cold-start budget (`data-boot-ms`, nightly) — that is why there are two legs.
fn build_app() -> App<MockRuntime> {
    app_lib::configure_app(mock_builder(), app_lib::logging().skip_logger())
        .build(mock_context(noop_assets()))
        .expect("mock app must build")
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("mock webview must build")
}

/// A real IPC request, as the webview would send it — including the origin the IPC layer
/// validates and the invoke key it checks.
fn invoke_request(command: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: command.to_owned(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("static origin must parse"),
        body: InvokeBody::default(),
        headers: tauri::http::HeaderMap::new(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

/// The boot chain: config parse, log-plugin registration, typed invoke-handler wiring, specta
/// event mount, `.setup()`. A blocking call added to `.setup()` shows up HERE, in a blocking
/// lane, rather than as a slower cold start that only a human would ever notice.
fn boot(c: &mut Criterion) {
    let mut group = c.benchmark_group("boot");
    group.bench_function("app_build", |b| {
        b.iter(|| black_box(build_app()));
    });
    group.finish();
}

/// One bench per command: the full round-trip through the real invoke handler — request
/// deserialization, command dispatch, the command body, response serialization.
///
/// `iter_batched` builds the request OUTSIDE the timed region: constructing it is bench
/// scaffolding, and folding its allocation into every sample would dilute a regression in
/// the command itself.
fn ipc(c: &mut Criterion) {
    let app = build_app();
    let webview = main_webview(&app);

    let mut group = c.benchmark_group("ipc");
    for command in COMMANDS {
        group.bench_function(*command, |b| {
            b.iter_batched(
                || invoke_request(command),
                |request| {
                    black_box(
                        tauri::test::get_ipc_response(&webview, request)
                            .expect("command must resolve"),
                    )
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

criterion_group!(host, boot, ipc);
criterion_main!(host);
