import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    // React Compiler — babel-plugin-react-compiler is EXACT-pinned in the
    // workspace catalog (check-version-sync asserts the pin). Wired through
    // @rolldown/plugin-babel per @vitejs/plugin-react v6 (Vite 8/rolldown).
    // SOURCE: React Compiler 1.0 adoption with an exact pin [corpus: react/compiler]
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  // Never clear the terminal: it hides Rust compile errors during `tauri dev`.
  clearScreen: false,
  server: {
    // SOURCE: Tauri v2 Vite integration — fixed dev port 1420, fail instead of
    // drifting (tauri.conf.json devUrl points here) [corpus: tauri/vite-integration]
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // Only VITE_-prefixed vars are inlined into the shipped bundle; secrets must
  // never carry the prefix (the write-guard bans secret-ish VITE_ names).
  envPrefix: ['VITE_'],
  build: {
    // SOURCE: Tauri v2 docs — WebView2 is Chromium >=105 on Windows; safari13
    // keeps macOS/Linux dev hosts (WKWebView/WebKitGTK) working
    // [corpus: tauri/vite-integration]
    target: ['es2022', 'chrome105', 'safari13'],
  },
})
