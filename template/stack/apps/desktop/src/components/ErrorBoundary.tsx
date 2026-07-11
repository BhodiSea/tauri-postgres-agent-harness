import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

// Without a boundary, ANY render exception unmounts the tree and ships as an
// invisible blank-desktop-window ticket. The fallback names the error, offers
// a reload, and stays inside the design tokens so even the failure state looks
// intentional. Class component: error boundaries have no hook equivalent.
// SOURCE: React error boundary docs — getDerivedStateFromError [corpus: harness/doctrine]
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override state: ErrorBoundaryState = { error: null }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas p-8 text-ink"
        >
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="max-w-md text-center text-sm text-ink-muted">
            {this.state.error.message ||
              'An unexpected error occurred while rendering this screen.'}
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.reload()
            }}
            className="rounded border border-edge bg-surface px-4 py-2 text-sm text-ink hover:border-accent"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
