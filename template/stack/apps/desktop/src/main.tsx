import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { hostAccessToken } from './auth/host-token'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initLocale } from './i18n'
import { attachConsole, isTauri } from './ipc'
import { setAccessTokenProvider } from './lib/api-client'
import { stampBootTiming } from './lib/boot-timing'
import { initTheme } from './theme/theme'
import './styles.css'

// Wire the API client to the HOST-held bearer token before any feature can fetch.
// The client is unauthenticated until this runs, so a forgotten wire fails loudly on the
// first request instead of quietly sending a bare one and reading as a server fault.
setAccessTokenProvider(hostAccessToken)

// Resolve the persisted (or system) theme onto <html data-theme> BEFORE the
// first React render, so the correct light/dark tokens are live at first paint
// and no theme flash occurs.
initTheme()

// Same discipline, one attribute over: resolve the persisted (or negotiated) locale onto
// <html lang> and <html dir> BEFORE the first render. `dir` is what makes the browser mirror
// the layout and reorder bidirectional text, so setting it after paint would flash an
// LTR frame at an RTL reader — the text equivalent of the theme flash above.
initLocale()

// Forward Rust-side log records into the webview devtools console (dev aid;
// tauri-plugin-log still writes the host log file regardless).
if (isTauri()) {
  void attachConsole()
}

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html must contain <div id="root">')
}

createRoot(container).render(
  <StrictMode>
    {/* Boundary at the root: a render exception must surface as a styled,
        recoverable alert — never a silent blank desktop window. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// Cold start is only real once the user can SEE the shell, so the measurement waits for the
// frame to land: the first rAF callback runs before that paint, the second after it. Asking
// the host any earlier would report a number the user never experienced.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void stampBootTiming()
  })
})
