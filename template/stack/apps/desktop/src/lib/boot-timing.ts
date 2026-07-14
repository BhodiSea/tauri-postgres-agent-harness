import { commands, isTauri } from '../ipc'

/**
 * Publish cold-start time onto `<html data-boot-ms>` once the shell is on screen.
 *
 * Cold start is the one performance number NEITHER side can measure alone: the host owns the
 * process clock (it knows when the exe started) and the webview owns "interactive" (it knows
 * when the first frame painted). This joins them — the webview asks the host how long it has
 * been alive, at the exact moment it becomes usable — and parks the answer somewhere a
 * WebDriver session can read it (`e2e-windows/coldstart.e2e.ts`, budgeted in
 * `tools/native-perf-budget.json#coldStart`).
 *
 * The criterion benches in `src-tauri/benches/host.rs` deliberately CANNOT see this: they run
 * on a mock runtime with no OS loader, no WebView2, no asset decode and no React. They are the
 * sensitive, deterministic, per-PR floor over the code this project owns; this is the coarse
 * wall-clock number over the whole real binary. Neither replaces the other.
 *
 * Deliberately fire-and-forget. A telemetry read must never delay the paint it is measuring,
 * and a project without a Tauri host (browser dev server, the mock-IPC e2e lane) simply has no
 * boot to report — hence the `isTauri()` guard and the swallowed rejection.
 */
export async function stampBootTiming(): Promise<void> {
  if (!isTauri()) return
  try {
    const elapsed = await commands.bootElapsedMs()
    document.documentElement.dataset['bootMs'] = String(elapsed)
  } catch {
    // The host is the source of truth and it did not answer. A missing attribute is a
    // measurement that did not happen; the cold-start spec fails loudly on its absence rather
    // than passing on a fabricated zero.
  }
}
