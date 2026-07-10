import { HealthResponse } from '@app/schema'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

// SOURCE: harness doctrine — degraded-network states are a first-class UI
// concern; probe cadence is slow enough to stay invisible in server logs and
// the per-probe timeout keeps a dead API from wedging the indicator
// [corpus: harness/doctrine]
const POLL_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000

// Dev override via Vite env; otherwise the API origin baked into the committed
// CSP (tauri.conf.json connect-src) at install time.
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '{{API_ORIGIN}}'

type ProbeState =
  | { readonly status: 'ok'; readonly version: string }
  | { readonly status: 'degraded' }

export function ConnectionStatus() {
  const [state, setState] = useState<ProbeState>({ status: 'degraded' })

  useEffect(() => {
    let cancelled = false
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_ORIGIN}/healthz`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`healthz responded ${String(response.status)}`)
        const body: unknown = await response.json()
        // HealthResponse pins `ok: literal(true)` — a degraded body fails the
        // parse and lands in the catch below.
        const health = HealthResponse.parse(body)
        if (!cancelled) {
          setState({ status: 'ok', version: health.version })
        }
      } catch {
        if (!cancelled) setState({ status: 'degraded' })
      }
    }
    void probe()
    const timer = setInterval(() => {
      void probe()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <p aria-live="polite" role="status" className="flex items-center gap-2 text-xs">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          state.status === 'ok' ? 'bg-accent' : 'border border-ink-muted bg-transparent',
        )}
      />
      {state.status === 'ok' ? (
        <span className="text-ink">API connected (v{state.version})</span>
      ) : (
        <span className="text-ink-muted">API unreachable — retrying</span>
      )}
    </p>
  )
}
