import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  apiFetch,
  apiPost,
  setAccessTokenProvider,
  UnauthenticatedError,
} from './api-client'

// The regression these tests exist for: every desktop fetch used to send only a
// content-type header, so the notes list, the optimistic create and the keyset pager
// each 401'd against the real server — while every gate stayed green, because every
// test and the whole e2e lane mocked the network. The integration lane (e2e/
// integration.spec.ts) proves the seam against a real server; these are the fast,
// always-on guards that the header is attached and that a missing token never
// silently degrades into an unauthenticated request.

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

function captureFetch(response: Response = okJson({ ok: true })): {
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    return Promise.resolve(response)
  })
  return { calls }
}

const headerOf = (init: RequestInit, name: string): string | null =>
  new Headers(init.headers).get(name)

afterEach(() => {
  vi.unstubAllGlobals()
  // The provider is re-installed by test-setup's beforeEach, so a signed-out case here
  // cannot leak into the next test.
})

describe('apiFetch', () => {
  it('attaches the host-held bearer token to every authenticated request', async () => {
    setAccessTokenProvider(() => Promise.resolve('token-abc'))
    const { calls } = captureFetch()

    await apiFetch('/api/notes')

    expect(calls).toHaveLength(1)
    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBe('Bearer token-abc')
  })

  it('REFUSES to send when there is no token, rather than sending a bare request', async () => {
    // A bare request would come back 401 and render as a server fault. The bug is local:
    // say so, and never put an unauthenticated call on the wire.
    setAccessTokenProvider(() => Promise.resolve(null))
    const { calls } = captureFetch()

    await expect(apiFetch('/api/notes')).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(calls, 'an unauthenticated request must never reach the network').toHaveLength(0)
  })

  it('REFUSES to send when the token is EMPTY, rather than sending a bare `Bearer ` header', async () => {
    // The empty string is the dangerous shape: it is not null, so a `token === null` check
    // alone waves it through and the app sends `Authorization: Bearer ` — a syntactically
    // valid header carrying nothing, which the server rejects as if the USER were at fault.
    // Same bug class as an empty-string audience env var silently disabling verification:
    // "present but empty" must mean unauthenticated, never "authenticated with nothing".
    setAccessTokenProvider(() => Promise.resolve(''))
    const { calls } = captureFetch()

    await expect(apiFetch('/api/notes')).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(calls, 'an empty token is not a token — nothing may reach the network').toHaveLength(0)
  })

  it('ships UNAUTHENTICATED by default: a forgotten provider fails loudly, it never sends bare', async () => {
    // The module-level default provider, before main.tsx (or a test) installs a real one.
    // It must resolve NULL — a default that resolved undefined, or was simply absent, would
    // sail past the token guard and put an unauthenticated request on the wire, which reads
    // as a server fault. Reached through a fresh module instance because test-setup installs
    // a provider into the shared one before every test.
    vi.resetModules()
    const fresh = await import('./api-client')
    const { calls } = captureFetch()

    await expect(fresh.apiFetch('/api/notes')).rejects.toBeInstanceOf(fresh.UnauthenticatedError)
    expect(calls, 'a forgotten wire must fail, not degrade into a bare request').toHaveLength(0)
  })

  it('targets the API origin baked in at install time when VITE_API_ORIGIN is unset', async () => {
    // The dev override is absent in the unit environment, so this pins the FALLBACK — the
    // same origin committed into tauri.conf.json's CSP connect-src. A wrong default here is
    // a desktop build that talks to an origin the CSP blocks, or worse, to a relative path.
    setAccessTokenProvider(() => Promise.resolve('token-abc'))
    const { calls } = captureFetch()

    await apiFetch('/api/notes')

    expect(calls[0]?.url).toBe('{{API_ORIGIN}}/api/notes')
  })

  it('sends the liveness probe WITHOUT auth — a signed-out server is reachable, not degraded', async () => {
    setAccessTokenProvider(() => Promise.resolve(null))
    const { calls } = captureFetch()

    await apiFetch('/healthz', { auth: false })

    expect(calls).toHaveLength(1)
    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBeNull()
  })

  it('surfaces the server error envelope message, not a bare status code', async () => {
    setAccessTokenProvider(() => Promise.resolve('token-abc'))
    const requestId = '00000000-0000-4000-8000-0000000000ff'
    captureFetch(
      new Response(
        JSON.stringify({
          error: { code: 'bad_request', message: 'title must not be empty', requestId },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    )

    const error = await apiFetch('/api/notes').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).message).toBe('title must not be empty')
    expect((error as ApiRequestError).status).toBe(400)
    expect((error as ApiRequestError).code).toBe('bad_request')
    expect((error as ApiRequestError).requestId).toBe(requestId)
  })

  it('still yields a usable error when the body is not an envelope (a proxy 502)', async () => {
    setAccessTokenProvider(() => Promise.resolve('token-abc'))
    captureFetch(new Response('<html>Bad Gateway</html>', { status: 502 }))

    const error = await apiFetch('/api/notes').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).status).toBe(502)
  })
})

// Error IDENTITY is a contract, not decoration: src/i18n/errors.ts branches on `instanceof`
// and reads `.code`/`.requestId` to pick the user-facing copy, quoting `.message` beneath it
// as the technical detail. Blur any of that and every failure surface renders the wrong thing.
describe('error identity', () => {
  it('ApiRequestError carries the envelope verbatim — the fields i18n/errors.ts maps to copy', () => {
    const error = new ApiRequestError('title must not be empty', 400, 'bad_request', 'req-42')

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiRequestError')
    expect(error.message).toBe('title must not be empty')
    expect(error.status).toBe(400)
    expect(error.code).toBe('bad_request')
    expect(error.requestId).toBe('req-42')
  })

  it('UnauthenticatedError names the SIGNED-OUT state — a local refusal, not a server fault', () => {
    const error = new UnauthenticatedError()

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('UnauthenticatedError')
    expect(error.message).toBe('not signed in')
  })
})

describe('apiPost', () => {
  it('carries both the bearer token and the json content-type the server requires', async () => {
    setAccessTokenProvider(() => Promise.resolve('token-abc'))
    const { calls } = captureFetch(okJson({ id: 'n1' }))

    await apiPost('/api/notes', { title: 'hello' })

    const call = calls[0]
    expect(call).toBeDefined()
    const init: RequestInit = call?.init ?? {}
    expect(headerOf(init, 'authorization')).toBe('Bearer token-abc')
    expect(headerOf(init, 'content-type')).toBe('application/json')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ title: 'hello' }))
  })
})
