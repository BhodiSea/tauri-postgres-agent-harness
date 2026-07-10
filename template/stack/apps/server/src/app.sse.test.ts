import { once } from 'node:events'
import { createAdaptorServer } from '@hono/node-server'
import { describe, expect, it, vi } from 'vitest'
import { type AppOptions, createApp } from './app.js'

const baseOptions: AppOptions = {
  version: '0.1.0',
  verifyToken: () => Promise.resolve({ userId: '11111111-1111-4111-8111-111111111111' }),
}

const authed = { authorization: 'Bearer test-token' }

describe('GET /api/events/demo (SSE)', () => {
  it('streams exactly 3 ticks then closes', async () => {
    const app = createApp({ ...baseOptions, sseTickMs: 1 })
    const res = await app.request('/api/events/demo', { headers: authed })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    expect(body.match(/event: tick/g)).toHaveLength(3)
    expect(body).toContain('data: 3')
  })

  it('propagates a client abort into the server-side generator', async () => {
    const onSseAbort = vi.fn()
    const app = createApp({ ...baseOptions, sseTickMs: 200, onSseAbort })
    // Real sockets on an ephemeral port: abort propagation only exists over a
    // live connection, so app.request() cannot exercise it.
    const server = createAdaptorServer({ fetch: app.fetch })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address')
      }
      const controller = new AbortController()
      const res = await fetch(`http://127.0.0.1:${String(address.port)}/api/events/demo`, {
        headers: authed,
        signal: controller.signal,
      })
      expect(res.status).toBe(200)
      if (res.body === null) {
        throw new Error('expected a streaming body')
      }
      const reader = res.body.getReader()
      await reader.read() // first tick arrived — the stream is live
      expect(onSseAbort).not.toHaveBeenCalled()
      controller.abort()
      await vi.waitFor(
        () => {
          expect(onSseAbort).toHaveBeenCalledTimes(1)
        },
        { timeout: 2000 },
      )
    } finally {
      server.close()
    }
  })
})
