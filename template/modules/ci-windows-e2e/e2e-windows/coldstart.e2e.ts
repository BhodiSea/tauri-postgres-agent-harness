// Cold-start TTI against the REAL SIGNED BINARY (ci-windows-e2e module).
//
// This is the only measurement in the harness that sees the whole thing: the OS loader
// mapping the exe, WebView2 starting, the isolation iframe, asset decode, the real logger
// install, React mounting. The criterion benches (src-tauri/benches/host.rs) structurally
// cannot — they run on a mock runtime with no window and no webview. They are the sensitive,
// deterministic, blocking-per-PR floor over the code this project owns; this is the coarse,
// wall-clock, whole-binary number. Neither substitutes for the other.
//
// The number itself is joined host-side + webview-side: `boot_elapsed_ms` reads the host's
// monotonic clock, and main.tsx stamps it onto <html data-boot-ms> after the first paint.
// Neither half could produce it alone.
//
// HONEST LIMIT — wall-clock on a shared Windows runner, run NIGHTLY. That makes it a
// monitor, not a merge gate, and a step-function detector (a blocking call in boot, a sync
// network fetch at startup), not a drift ratchet. The budget carries runner headroom
// accordingly. Deliberate: a tight wall-clock budget on shared hardware flakes, and a flaky
// gate teaches a team to ignore red.

interface WdioElement {
  waitForDisplayed: (options?: { timeout?: number }) => Promise<void>
}

interface WdioBrowser {
  $: (selector: string) => WdioElement & PromiseLike<WdioElement>
  waitUntil: (
    condition: () => Promise<boolean>,
    options?: { timeout?: number; timeoutMsg?: string },
  ) => Promise<void>
  execute: <T>(script: (...args: unknown[]) => T) => Promise<T>
}

declare const browser: WdioBrowser
declare function describe(name: string, fn: () => void): void
declare function it(name: string, fn: () => Promise<void>): void

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

// Keep in lockstep with tools/native-perf-budget.json#coldStart.maxBootMs. The module's
// workflow asserts they agree before this spec runs, so a budget raised in the JSON cannot
// silently leave the spec enforcing the old (or a fabricated) number.
const MAX_BOOT_MS = 4000

describe('cold start (real binary, WebDriver)', () => {
  it('reaches an interactive shell within the boot budget', async () => {
    // The shell being on screen is what "interactive" MEANS here; the stamp lands on the
    // frame after it paints.
    await browser.$('header').waitForDisplayed({ timeout: 30_000 })

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset['bootMs'])) !== undefined,
      {
        timeout: 30_000,
        timeoutMsg:
          '<html data-boot-ms> was never stamped — main.tsx did not reach stampBootTiming(), or the ' +
          'boot_elapsed_ms command failed. Cold start is UNMEASURED, which is the state this lane exists ' +
          'to prevent; it fails rather than passing on a missing number.',
      },
    )

    const raw = await browser.execute(() => document.documentElement.dataset['bootMs'])
    const bootMs = Number(raw)

    // A zero would mean the host never started its clock (BOOT unset — the mock/bench path),
    // i.e. we are not measuring the real binary at all. That must fail, not silently pass.
    assert(
      Number.isFinite(bootMs) && bootMs > 0,
      `data-boot-ms must be a positive number of milliseconds, got "${String(raw)}" — a zero means the host ` +
        'clock never started, so this is not a real boot',
    )

    assert(
      bootMs <= MAX_BOOT_MS,
      `cold start took ${String(bootMs)}ms, over the ${String(MAX_BOOT_MS)}ms budget ` +
        '(tools/native-perf-budget.json#coldStart). Something now blocks the boot path: a synchronous ' +
        'network call, sync filesystem work in setup(), or a heavy import landing before first paint.',
    )
  })
})
