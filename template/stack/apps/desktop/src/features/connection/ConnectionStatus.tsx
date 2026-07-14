import { HealthResponse } from '@app/schema'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api-client'
import { cn } from '../../lib/utils'

// SOURCE: harness doctrine — degraded-network states are a first-class UI
// concern; probe cadence is slow enough to stay invisible in server logs and
// the per-probe timeout keeps a dead API from wedging the indicator
// [corpus: harness/doctrine]
const POLL_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000

// Dispatched by the command palette's "Probe API connection now" — the status
// indicator owns the probe loop; other features only ever signal it.
export const PROBE_CONNECTION_EVENT = 'app:probe-connection'

// Three states, not two: rendering "unreachable — retrying" before the FIRST
// probe resolves is a lie that trains users to distrust the indicator.
type ProbeState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ok'; readonly version: string }
  | { readonly status: 'degraded' }

export function ConnectionStatus() {
  const [state, setState] = useState<ProbeState>({ status: 'connecting' })

  useEffect(() => {
    let cancelled = false
    const probe = async (): Promise<void> => {
      try {
        // The liveness probe is the ONE unauthenticated call: it must report a
        // reachable-but-signed-out server as connected, not degraded.
        const response = await apiFetch('/healthz', {
          auth: false,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
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
    const probeNow = (): void => {
      setState({ status: 'connecting' })
      void probe()
    }
    void probe()
    const timer = setInterval(() => {
      void probe()
    }, POLL_INTERVAL_MS)
    window.addEventListener(PROBE_CONNECTION_EVENT, probeNow)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener(PROBE_CONNECTION_EVENT, probeNow)
    }
  }, [])

  return (
    <p aria-live="polite" role="status" className="flex items-center gap-2 text-xs">
      {/* The dot is decorative (aria-hidden) — the text beside it carries the meaning.
          But `degraded` and `connecting` used to render the SAME hollow ink-muted dot,
          differing only by an animation that reduced-motion users never see: at a glance
          a dead API was indistinguishable from one still connecting. Degraded now takes
          the danger token, connected takes success. */}
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          state.status === 'ok' && 'bg-success',
          state.status === 'connecting' &&
            'border border-ink-muted bg-transparent motion-safe:animate-pulse',
          state.status === 'degraded' && 'bg-danger',
        )}
      />
      {state.status === 'ok' ? (
        <span className="text-ink">API connected (v{state.version})</span>
      ) : state.status === 'connecting' ? (
        <span className="text-ink-muted">Connecting to API…</span>
      ) : (
        <span className="text-ink-muted">API unreachable — retrying</span>
      )}
    </p>
  )
}
