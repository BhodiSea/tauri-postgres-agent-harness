import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { hostAccessToken } from './auth/host-token'
import { ErrorBoundary } from './components/ErrorBoundary'
import { attachConsole, isTauri } from './ipc'
import { setAccessTokenProvider } from './lib/api-client'
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
