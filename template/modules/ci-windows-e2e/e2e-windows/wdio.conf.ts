// WebdriverIO config for the real-binary Windows E2E lane (ci-windows-e2e module).
// tauri-driver bridges the WebDriver protocol to the Tauri app: WDIO talks to
// tauri-driver on :4444, which spawns the DEBUG binary and drives its WebView2
// via a version-matched msedgedriver (installed by the workflow).
//
// Written dependency-free on purpose: the types below mirror the small slice of
// WDIO config surface this lane uses, so enabling the module does not force WDIO
// devDependencies on every project. For a durable local setup, install the real
// toolchain and swap these local types for '@wdio/types' (see the module README).

interface TauriCapability {
  readonly browserName: string
  readonly maxInstances: number
  readonly 'tauri:options': {
    readonly application: string
  }
}

interface WdioLiteConfig {
  readonly runner: 'local'
  readonly hostname: string
  readonly port: number
  readonly specs: readonly string[]
  readonly maxInstances: number
  readonly capabilities: readonly TauriCapability[]
  readonly logLevel: 'info' | 'warn' | 'error'
  readonly framework: 'mocha'
  readonly reporters: readonly string[]
  readonly mochaOpts: { readonly ui: 'bdd'; readonly timeout: number }
  readonly waitforTimeout: number
  readonly connectionRetryCount: number
}

export const config: WdioLiteConfig = {
  runner: 'local',
  // tauri-driver listens here (the workflow starts it; locally: `tauri-driver`).
  hostname: '127.0.0.1',
  port: 4444,
  specs: ['./*.e2e.ts'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'wry',
      maxInstances: 1,
      'tauri:options': {
        // Debug binary produced by `pnpm --filter desktop exec tauri build --debug --no-bundle`.
        // Tauri 2 names the built binary after the CARGO BIN ("desktop", fixed in
        // src-tauri/Cargo.toml), NOT tauri.conf.json's productName — verified on a
        // real Windows runner by the harness selftest's install/uninstall smoke.
        application: '../apps/desktop/src-tauri/target/debug/desktop.exe',
      },
    },
  ],
  logLevel: 'info',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  waitforTimeout: 20_000,
  connectionRetryCount: 2,
}
