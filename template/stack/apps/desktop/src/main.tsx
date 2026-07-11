import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { attachConsole, isTauri } from './ipc'
import './styles.css'

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
