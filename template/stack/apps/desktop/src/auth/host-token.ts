import { commands, isTauri } from '../ipc'

// Where the desktop's bearer token comes from: the Tauri HOST, over typed IPC.
//
// Not from a `VITE_` env var (those are compiled into the shipped client bundle — the
// write-guard bans any secret-shaped VITE_ name), and not from webview storage (readable
// by any injected script). The host owns the credential; the webview borrows it per
// request through src/lib/api-client.ts.
//
// Outside Tauri there is no host to ask — a browser dev server, the unit suite, the
// mock-IPC e2e lane — so this reports unauthenticated and those callers install their own
// provider. Returning null (rather than throwing) keeps `pnpm dev:desktop` in a browser
// tab a usable surface: it renders the signed-out state instead of a white screen.
// SOURCE: Tauri 2 security model — the webview is untrusted; secrets stay host-side
// [corpus: tauri/capabilities]
export async function hostAccessToken(): Promise<string | null> {
  if (!isTauri()) return null
  return await commands.accessToken()
}
