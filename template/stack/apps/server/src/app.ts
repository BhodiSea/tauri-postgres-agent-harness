import { readFileSync } from 'node:fs'
import { ApiError, HealthResponse, type NewNote, NewNoteInput, NoteDto } from '@app/schema'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createTokenVerifier, type TokenVerifier } from './auth/verify.js'
import { notesDal } from './dal/notes.js'
import { createSkewMiddleware } from './middleware/skew.js'
import type { AppEnv, NotesDal } from './types.js'

const SSE_DEMO_TICKS = 3

const PackageJsonDto = z.object({ version: z.string() })

// Resolves both layouts: src/ next to package.json (tsx dev) and dist/src/ (compiled).
function readPackageVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    let raw: string
    try {
      raw = readFileSync(new URL(candidate, import.meta.url), 'utf8')
    } catch {
      continue
    }
    const parsed: unknown = JSON.parse(raw)
    return PackageJsonDto.parse(parsed).version
  }
  throw new Error('unable to locate the server package.json to read its version')
}

// z.guid() matches the postgres uuid type (any 8-4-4-4-12 hex, no RFC variant check).
const NoteParamsDto = z.object({ id: z.guid() })

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  responses: {
    200: {
      description:
        'Liveness probe — no auth, no version gate; the desktop status indicator polls it',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
})

const listNotesRoute = createRoute({
  method: 'get',
  path: '/api/notes',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'All notes owned by the authenticated user (scoped by RLS)',
      content: { 'application/json': { schema: z.array(NoteDto) } },
    },
  },
})

const createNoteRoute = createRoute({
  method: 'post',
  path: '/api/notes',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: NewNoteInput } },
    },
  },
  responses: {
    201: {
      description: 'The created note',
      content: { 'application/json': { schema: NoteDto } },
    },
  },
})

const getNoteRoute = createRoute({
  method: 'get',
  path: '/api/notes/{id}',
  security: [{ Bearer: [] }],
  request: { params: NoteParamsDto },
  responses: {
    200: {
      description: 'The requested note',
      content: { 'application/json': { schema: NoteDto } },
    },
    404: {
      description: 'No such note visible to this user',
      content: { 'application/json': { schema: ApiError } },
    },
  },
})

const deleteNoteRoute = createRoute({
  method: 'delete',
  path: '/api/notes/{id}',
  security: [{ Bearer: [] }],
  request: { params: NoteParamsDto },
  responses: {
    204: { description: 'Note deleted' },
    404: {
      description: 'No such note visible to this user',
      content: { 'application/json': { schema: ApiError } },
    },
  },
})

export interface AppOptions {
  /** Server version; defaults to the package.json version. */
  readonly version?: string
  /** Token verifier; defaults to the AUTH_MODE-configured verifier (env). */
  readonly verifyToken?: TokenVerifier
  /** Notes DAL; tests inject fakes here. */
  readonly notesDal?: NotesDal
  /** Milliseconds between SSE demo ticks. */
  readonly sseTickMs?: number
  /** Test hook: invoked when an SSE client aborts mid-stream. */
  readonly onSseAbort?: () => void
}

export function createApp(options: AppOptions = {}): OpenAPIHono<AppEnv> {
  const version = options.version ?? readPackageVersion()
  const verifyToken = options.verifyToken ?? createTokenVerifier(process.env)
  const dal = options.notesDal ?? notesDal
  const sseTickMs = options.sseTickMs ?? 250
  const onSseAbort = options.onSseAbort

  const app = new OpenAPIHono<AppEnv>()

  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })

  app.openapi(healthRoute, (c) => c.json({ ok: true as const, version }, 200))

  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const authorization = c.req.header('authorization')
    const token =
      authorization?.startsWith('Bearer ') === true
        ? authorization.slice('Bearer '.length)
        : undefined
    if (token === undefined || token === '') {
      return c.json({ error: 'unauthorized' }, 401)
    }
    try {
      const { userId } = await verifyToken(token)
      c.set('userId', userId)
    } catch {
      // Verification failures collapse to a bare 401: token errors must not leak
      // why a credential was rejected.
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
    return undefined
  }

  // Every /api/* route sits behind BOTH guards; /healthz and /openapi.json are
  // deliberately outside. The skew unit test walks app.routes to prove coverage.
  app.use('/api/*', createSkewMiddleware(version))
  app.use('/api/*', requireAuth)

  app.openapi(listNotesRoute, async (c) => {
    const notes = await dal.list(c.get('userId'))
    return c.json(notes, 200)
  })

  app.openapi(createNoteRoute, async (c) => {
    const input: NewNote = c.req.valid('json')
    const note = await dal.create(c.get('userId'), input)
    return c.json(note, 201)
  })

  app.openapi(getNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const note = await dal.get(c.get('userId'), id)
    return note === null ? c.json({ error: 'not_found' }, 404) : c.json(note, 200)
  })

  app.openapi(deleteNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const removed = await dal.remove(c.get('userId'), id)
    return removed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
  })

  // SSE demo: streams three ticks then closes. Not part of the OpenAPI surface
  // (event streams do not fit request/response schemas), hence plain app.get.
  app.get('/api/events/demo', (c) =>
    streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        // SOURCE: SSE doctrine — client aborts MUST stop the producer; an orphaned
        // generator per dropped client is a slow server leak [corpus: harness/doctrine]
        onSseAbort?.()
      })
      for (let tick = 1; tick <= SSE_DEMO_TICKS && !stream.aborted; tick += 1) {
        await stream.writeSSE({ event: 'tick', data: String(tick), id: String(tick) })
        await stream.sleep(sseTickMs)
      }
    }),
  )

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'server',
      version,
      description:
        'Notes API — the demo vertical slice. Regenerate openapi.json via `pnpm --filter server openapi:emit`.',
    },
  })

  return app
}
