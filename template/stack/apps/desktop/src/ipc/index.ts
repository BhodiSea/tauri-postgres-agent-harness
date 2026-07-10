// The ONLY module allowed to import @tauri-apps/* (outside src/keyboard/):
// every IPC capability the UI may use is re-exported from here, so the
// invoke surface stays reviewable in one place (lint-enforced).

export { isTauri } from '@tauri-apps/api/core'
export { attachConsole } from '@tauri-apps/plugin-log'
export { commands } from './bindings'
