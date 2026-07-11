import { useCallback, useEffect, useRef, useState } from 'react'

// Generic list-query lifecycle for a screen's primary data: ONE state machine
// behind the loading / empty / error / ready surfaces every route declares in
// src/routes.ts (e2e/states.spec.ts drives each state). The fetcher is injected,
// so swapping the data source is a one-line change at the call site and tests
// can drive every state without a network.

export type ListQueryState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly items: readonly T[] }
  | { readonly status: 'error'; readonly message: string }

export type ListFetcher<T> = (signal: AbortSignal) => Promise<readonly T[]>

export function useListQuery<T>(fetcher: ListFetcher<T>): {
  readonly state: ListQueryState<T>
  /** Re-runs the fetcher from scratch — the error state's retry affordance. */
  readonly reload: () => void
} {
  const [state, setState] = useState<ListQueryState<T>>({ status: 'loading' })
  // Single-flight: starting a new load aborts the previous one, so a stale slow
  // response can never overwrite a newer state.
  const controllerRef = useRef<AbortController | null>(null)

  const run = useCallback(
    (controller: AbortController) => {
      controllerRef.current?.abort()
      controllerRef.current = controller
      fetcher(controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return
          setState(items.length === 0 ? { status: 'empty' } : { status: 'ready', items })
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        })
    },
    [fetcher],
  )

  // Mount (and fetcher change) starts the query WITHOUT a setState — the state
  // is 'loading' by construction, so the effect never renders in cascade. The
  // cleanup aborts whatever load is CURRENT (a reload may have replaced the
  // controller this effect created).
  useEffect(() => {
    run(new AbortController())
    return () => {
      controllerRef.current?.abort()
    }
  }, [run])

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    run(new AbortController())
  }, [run])

  return { state, reload }
}
