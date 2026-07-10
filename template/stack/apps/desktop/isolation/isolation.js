// Tauri isolation hook — runs inside the sandboxed isolation iframe, outside
// the main frontend's dependency tree, so a compromised npm package cannot
// forge IPC calls unseen. Inspect/enforce per-command payload rules here
// (e.g. reject path arguments outside expected roots) as commands grow; the
// scaffold ships a verbatim pass-through.
// SOURCE: Tauri v2 isolation pattern — every IPC payload is interceptable and
// re-encrypted before reaching core [corpus: tauri/isolation]
window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  return payload
}
