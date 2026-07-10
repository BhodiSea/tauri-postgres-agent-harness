import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from '../app.js'
import type { NotesDal } from '../types.js'
import { isSkewMiddleware } from './skew.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'

const emptyDal: NotesDal = {
  list: () => Promise.resolve([]),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

const options: AppOptions = {
  version: '1.2.3',
  verifyToken: () => Promise.resolve({ userId: USER_ID }),
  notesDal: emptyDal,
}

const authed = { authorization: 'Bearer test-token' }

describe('version-skew middleware', () => {
  it('passes a client on the same major', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': '1.0.0' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual([])
  })

  it('rejects a major mismatch with 409 version_skew', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': '2.0.0' },
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'version_skew' })
  })

  it('rejects an unparsable client version', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { ...authed, 'x-client-version': 'not-a-version' },
    })
    expect(res.status).toBe(409)
  })

  it('passes requests without the header (curl/tooling; the desktop always sends it)', async () => {
    const res = await createApp(options).request('/api/notes', { headers: authed })
    expect(res.status).toBe(200)
  })

  it('requires auth on /api/* even when the version matches', async () => {
    const res = await createApp(options).request('/api/notes', {
      headers: { 'x-client-version': '1.0.0' },
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' })
  })

  it('exempts /healthz from both the skew gate and auth', async () => {
    const res = await createApp(options).request('/healthz', {
      headers: { 'x-client-version': '9.9.9' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, version: '1.2.3' })
  })
})

describe('route coverage (walks the real route table — new /api routes cannot dodge the gate)', () => {
  it('covers every registered /api/* route with the skew middleware', () => {
    const app = createApp(options)
    const skewPrefixes = app.routes
      .filter((route) => isSkewMiddleware(route.handler))
      .map((route) => route.path)
    expect(skewPrefixes.length).toBeGreaterThan(0)

    const apiRoutes = app.routes.filter(
      (route) => route.method !== 'ALL' && route.path.startsWith('/api/'),
    )
    // Non-vacuous: notes CRUD (4) + SSE demo (1) must all be present.
    const distinct = new Set(apiRoutes.map((route) => `${route.method} ${route.path}`))
    expect(distinct.size).toBeGreaterThanOrEqual(5)

    for (const route of apiRoutes) {
      const covered = skewPrefixes.some(
        (prefix) => prefix.endsWith('/*') && route.path.startsWith(prefix.slice(0, -1)),
      )
      expect(covered, `${route.method} ${route.path} must sit behind the skew middleware`).toBe(
        true,
      )
    }
  })

  it('leaves /healthz outside the skew middleware', () => {
    const app = createApp(options)
    const skewPrefixes = app.routes
      .filter((route) => isSkewMiddleware(route.handler))
      .map((route) => route.path)
    const healthCovered = skewPrefixes.some(
      (prefix) => prefix.endsWith('/*') && '/healthz'.startsWith(prefix.slice(0, -1)),
    )
    expect(healthCovered).toBe(false)
  })
})
