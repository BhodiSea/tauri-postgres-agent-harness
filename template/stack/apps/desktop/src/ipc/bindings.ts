// Committed tauri-specta bindings for the host's #[tauri::command] surface.
//
// This bootstrap copy is hand-authored to match the shape tauri-specta emits
// for the `app_version` command; the real exporter in src-tauri/src/lib.rs
// (debug builds only) OVERWRITES this file on the first `pnpm tauri dev`, and
// the CI rust lane fails on drift between Rust signatures and this file.
// SOURCE: tauri-specta v2 — committed generated bindings as the single typed
// IPC surface [corpus: tauri/specta-bindings]
import { invoke as TAURI_INVOKE } from '@tauri-apps/api/core'

export const commands = {
  appVersion(): Promise<string> {
    return TAURI_INVOKE<string>('app_version')
  },
}
