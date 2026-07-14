import { Component, type ReactNode } from 'react'
import { t } from '../i18n'
import { Button } from './Button'

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
//
// i18n: this is a CLASS, so useI18n() — a hook — cannot be called in render. It
// imports the PLAIN `t`, which reads the module-level active locale. That the
// i18n store is NOT a React context is exactly what makes this work: the one
// component that can never hold a hook is also the one that must never fail to
// render its own copy. Trade-off: a locale switch does not re-render a tripped
// boundary (no subscription), which is harmless — the boundary is terminal and
// the next thing a user does here is Reload.
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
          {/* The heading takes the danger token: this is the one screen where the app
              has FAILED, and it rendered in the same ink as ordinary chrome. The body
              copy stays `text-ink-muted` so the message itself remains easy to read. */}
          <h1 className="text-base font-semibold text-danger">{t('error.title')}</h1>
          <p className="max-w-md text-center text-sm text-ink-muted">{t('error.body')}</p>
          {/* The raw Error.message is DEVELOPER copy, not user copy: it is whatever
              string a throw site happened to pass, it is never in the catalog, and it
              can never be translated. It used to stand IN for the body paragraph, which
              made an untranslatable string the primary thing a user read. It still ships
              — dropping it would cost the one detail that makes a report actionable —
              but demoted to a technical footnote under the translated copy above. Guarded
              on non-empty so a message-less throw renders no empty line. */}
          {this.state.error.message !== '' && (
            <p className="max-w-md text-center font-mono text-xs text-ink-muted">
              {this.state.error.message}
            </p>
          )}
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            {t('common.reload')}
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
