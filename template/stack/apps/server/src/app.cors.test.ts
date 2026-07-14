import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import type { NotesDal } from './types.js'

// The desktop is a CROSS-ORIGIN client — the Tauri webview serves the app from
// `tauri://localhost` (macOS/Linux) or `http://tauri.localhost` (Windows), and the API
// lives on its own origin. Two ways that silently locks the desktop out of its own API,
// both of which shipped:
//
//   1. No CORS headers at all — the request succeeds, the browser refuses to hand the
//      response to the app, and every screen renders its error state.
//   2. The auth guard placed AHEAD of CORS — a preflight (OPTIONS) carries no
//      Authorization header BY DEFINITION, so it 401s and the real request is never sent.
//
// The e2e integration lane catches both against a live server; these are the fast,
// always-on guards. A wildcard origin is NOT acceptable here: the API answers with the
// caller's own rows under FORCE RLS, so `*` would let any page a user visits read them
// with a stolen token.
// SOURCE: Tauri 2 serves the webview from a custom scheme, so the API is a cross-origin
// endpoint and must send CORS headers [corpus: tauri/capabilities]

const USER_ID = '11111111-1111-4111-8111-111111111111'

const emptyDal: NotesDal = {
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

const options: AppOptions = {
  version: '1.2.3',
  verifyToken: () => Promise.resolve({ userId: USER_ID }),
  notesDal: emptyDal,
}

const DESKTOP_ORIGIN = 'tauri://localhost'
const WINDOWS_ORIGIN = 'http://tauri.localhost'
const DEV_ORIGIN = 'http://localhost:1420'

const preflight = (origin: string): Request =>
  new Request('http://localhost/api/notes', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,x-client-version',
    },
  })

describe('CORS: the desktop can actually read its own API', () => {
  it.each([
    DESKTOP_ORIGIN,
    WINDOWS_ORIGIN,
    DEV_ORIGIN,
  ])('answers the preflight from %s WITHOUT requiring a token', async (origin) => {
    const response = await createApp(options).request(preflight(origin))

    // Not 401: a preflight never carries credentials, so an auth guard ahead of CORS
    // would lock the desktop out of every authenticated route.
    expect(response.status).not.toBe(401)
    expect(response.status).toBeLessThan(300)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)

    const allowedHeaders = response.headers.get('access-control-allow-headers') ?? ''
    expect(allowedHeaders).toContain('authorization')
    // The skew middleware reads x-client-version; an unlisted custom header fails the
    // preflight and the real request is never sent.
    expect(allowedHeaders).toContain('x-client-version')
  })

  it('lets the webview READ an authenticated response (allow-origin on the real request)', async () => {
    const response = await createApp(options).request('http://localhost/api/notes', {
      headers: { origin: DESKTOP_ORIGIN, authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(DESKTOP_ORIGIN)
    // The correlation id must be readable cross-origin or a user can never quote it.
    expect(response.headers.get('access-control-expose-headers') ?? '').toContain('x-request-id')
  })

  it('refuses an origin outside the allowlist — never a wildcard over RLS-scoped rows', async () => {
    const response = await createApp(options).request('http://localhost/api/notes', {
      headers: { origin: 'https://evil.example', authorization: 'Bearer test-token' },
    })

    const allowOrigin = response.headers.get('access-control-allow-origin')
    expect(allowOrigin).not.toBe('*')
    expect(allowOrigin).not.toBe('https://evil.example')
  })

  it('honors a deployment-configured origin allowlist', async () => {
    const app = createApp({ ...options, corsOrigins: ['https://desktop.example'] })

    const allowed = await app.request(preflight('https://desktop.example'))
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://desktop.example')

    // Configuring the list REPLACES the defaults — a deployment that pins its own origins
    // does not silently keep accepting the built-in ones.
    const denied = await app.request(preflight(DESKTOP_ORIGIN))
    expect(denied.headers.get('access-control-allow-origin')).not.toBe(DESKTOP_ORIGIN)
  })
})

// A preflight that asks for NOTHING in particular. This is the load-bearing detail: Hono's
// cors() falls back to ECHOING `access-control-request-headers` when its own allowHeaders
// list is empty, so a preflight that names the headers it wants gets them back whether or
// not the server actually allows them — the echo makes an empty policy look identical to a
// correct one. Asking for nothing removes the echo and forces the SERVER's own list onto
// the wire, which is the only thing the desktop's browser will honor.
const bareOptionsRequest = (origin: string): Request =>
  new Request('http://localhost/api/notes', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET' },
  })

describe('CORS policy: the exact methods and headers the desktop needs', () => {
  // `authorization` is the one that bites: drop it and every AUTHENTICATED browser request
  // dies in preflight while curl (which never preflights) stays green. `x-client-version` is
  // the skew guard's header, `content-type` is what makes a JSON POST non-simple.
  it.each([
    'authorization',
    'content-type',
    'x-client-version',
  ])('advertises %s in access-control-allow-headers', async (header) => {
    const res = await createApp(options).request(bareOptionsRequest(DESKTOP_ORIGIN))

    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-headers') ?? '').toContain(header)
  })

  it.each([
    'GET',
    'POST',
    'DELETE',
    'OPTIONS',
  ])('advertises %s in access-control-allow-methods', async (method) => {
    const res = await createApp(options).request(bareOptionsRequest(DESKTOP_ORIGIN))

    expect(res.headers.get('access-control-allow-methods') ?? '').toContain(method)
  })

  // CLOSURE, not a list. The literal table above pins today's methods; this pins TOMORROW's.
  // DELETE shipped missing from allowMethods while `deleteNoteRoute` was live: Hono's cors()
  // does not validate the requested method, it only ADVERTISES this list, so the preflight
  // answered 204 without DELETE and the browser silently refused to send the real request.
  // Deleting a note was impossible from the packaged app, and every test stayed green —
  // because the suite spoke to Hono directly, and curl never preflights. The next route an
  // agent adds must not be able to repeat that, so the assertion is derived from the ROUTE
  // TABLE rather than from a list a human has to remember to update.
  it('advertises EVERY method the route table declares — a missing one is an un-callable route', async () => {
    const app = createApp(options)
    const declared = new Set(
      app.routes
        .filter((route) => route.path.startsWith('/api/'))
        .map((route) => route.method.toUpperCase())
        // Hono registers middleware as ALL; it is not a callable method.
        .filter((method) => method !== 'ALL'),
    )
    expect(declared.size).toBeGreaterThan(0) // anti-vacuity: the walk must actually find routes

    const res = await createApp(options).request(bareOptionsRequest(DESKTOP_ORIGIN))
    const advertised = (res.headers.get('access-control-allow-methods') ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase())

    expect([...declared].filter((method) => !advertised.includes(method))).toEqual([])
  })
})

// resolveCorsOrigins(process.env): the deployment override. Read at construction, so every
// case builds the app INSIDE the test with the env it is asserting about.
describe('CORS_ORIGINS parsing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // `options` carries no corsOrigins, so createApp takes the process.env path.
  const allowedOrigin = async (origin: string): Promise<string | null> => {
    const res = await createApp(options).request(preflight(origin))
    return res.headers.get('access-control-allow-origin')
  }

  it('unset → the built-in Tauri + dev origins', async () => {
    vi.stubEnv('CORS_ORIGINS', undefined)

    expect(await allowedOrigin(DESKTOP_ORIGIN)).toBe(DESKTOP_ORIGIN)
    expect(await allowedOrigin(WINDOWS_ORIGIN)).toBe(WINDOWS_ORIGIN)
    expect(await allowedOrigin('https://evil.example')).not.toBe('https://evil.example')
  })

  it('a comma list → each origin, whitespace TRIMMED', async () => {
    // The whitespace is the point: a `CORS_ORIGINS=a, b` in a compose file or a .env is
    // ordinary, and an untrimmed ` b` matches no browser Origin header that exists.
    vi.stubEnv('CORS_ORIGINS', ' https://a.example , https://b.example ')

    expect(await allowedOrigin('https://a.example')).toBe('https://a.example')
    expect(await allowedOrigin('https://b.example')).toBe('https://b.example')
    // Configured REPLACES the defaults.
    expect(await allowedOrigin(DESKTOP_ORIGIN)).not.toBe(DESKTOP_ORIGIN)
  })

  it('drops empty entries — a trailing comma or a lone blank is not an origin', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://a.example,, ,https://b.example,')

    expect(await allowedOrigin('https://a.example')).toBe('https://a.example')
    expect(await allowedOrigin('https://b.example')).toBe('https://b.example')
  })

  it.each([
    '',
    '   ',
    ',',
    ' , , ',
  ])('CORS_ORIGINS=%j is EMPTY, so the built-in origins stand', async (value) => {
    // The `.length > 0` half of the fallback. A config that parses to zero origins is a
    // config that says nothing — it must not lock the desktop out of its own API by
    // installing an allowlist that allows no one.
    vi.stubEnv('CORS_ORIGINS', value)

    expect(await allowedOrigin(DESKTOP_ORIGIN)).toBe(DESKTOP_ORIGIN)
  })
})
