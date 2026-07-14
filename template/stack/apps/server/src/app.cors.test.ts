import { describe, expect, it } from 'vitest'
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
