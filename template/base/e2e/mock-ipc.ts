import type { Page } from '@playwright/test'

// Test doubles for the fast e2e lane: the app runs in plain chromium (vite dev),
// so the two host boundaries are stubbed here —
//   1. installMockIpc: a window.__TAURI_INTERNALS__/invoke mock, installed BEFORE
//      any app code runs, so `isTauri()` reports true and the typed IPC facade
//      (src/ipc/) resolves without a Rust host.
//   2. stubHealthz: page.route interception of the ConnectionStatus /healthz probe
//      (ok / HTTP error / connection refused). Fulfilled cross-origin responses
//      still pass the browser's CORS check, hence the explicit allow-origin header.
// Real-binary IPC + WebDriver coverage lives in the opt-in ci-windows-e2e module.

export interface MockIpcOptions {
  /** Version string the mocked `app_version` command reports. */
  readonly appVersion?: string
}

interface TauriInternalsMock {
  invoke: (cmd: string) => Promise<unknown>
  transformCallback: (callback?: (response: unknown) => void, once?: boolean) => number
  metadata: {
    currentWindow: { label: string }
    currentWebview: { label: string }
  }
}

export async function installMockIpc(page: Page, options: MockIpcOptions = {}): Promise<void> {
  const appVersion = options.appVersion ?? '0.1.0-e2e'
  await page.addInitScript(
    ({ version }) => {
      let nextCallbackId = 0
      const internals: TauriInternalsMock = {
        // Commands the scaffold shell uses; everything else (plugin:event|listen
        // from attachConsole, plugin:log forwarding, …) resolves to a benign id.
        invoke: (cmd: string): Promise<unknown> => {
          if (cmd === 'app_version') return Promise.resolve(version)
          nextCallbackId += 1
          return Promise.resolve(nextCallbackId)
        },
        transformCallback: (): number => {
          nextCallbackId += 1
          return nextCallbackId
        },
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
      }
      Object.defineProperty(window, 'isTauri', { value: true, configurable: true })
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: internals,
        configurable: true,
      })
    },
    { version: appVersion },
  )
}

export type HealthzStub =
  | { readonly kind: 'ok'; readonly version?: string }
  | { readonly kind: 'http-error'; readonly status?: number }
  | { readonly kind: 'offline' }

const CORS_HEADERS = { 'access-control-allow-origin': '*' } as const

export async function stubHealthz(page: Page, stub: HealthzStub): Promise<void> {
  await page.route('**/healthz', async (route) => {
    if (stub.kind === 'offline') {
      await route.abort('connectionrefused')
      return
    }
    if (stub.kind === 'http-error') {
      await route.fulfill({
        status: stub.status ?? 500,
        headers: CORS_HEADERS,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, version: stub.version ?? '0.1.0-e2e' }),
    })
  })
}
