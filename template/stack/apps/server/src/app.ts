import { readFileSync } from 'node:fs'
import {
  ApiError,
  HealthResponse,
  type NewNote,
  NewNoteInput,
  NoteDto,
  NotesListQuery,
  NotesPage,
} from '@app/schema'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { createTokenVerifier, type TokenVerifier } from './auth/verify.js'
import { decodeNotesCursor } from './dal/cursor.js'
import { notesDal } from './dal/notes.js'
import { apiError, notFoundHandler, onErrorHandler, requestId, validationHook } from './errors.js'
import { createSkewMiddleware } from './middleware/skew.js'
import type { AppEnv, NotesDal } from './types.js'

const SSE_DEMO_TICKS = 3

// 1 MiB cap on /api/* request bodies: the largest legal payload (a note with a
// 20 000-char body) is < 100 KiB even at 4-byte UTF-8, so 1 MiB is generous
// headroom while still refusing memory-amplification uploads before they buffer.
// SOURCE: Hono bodyLimit middleware https://hono.dev/docs/middleware/builtin/body-limit
const MAX_API_BODY_BYTES = 1024 * 1024

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

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: ApiError } },
  description,
})

// Failure modes shared by every authenticated /api route: request validation
// (400, via the defaultHook), the auth guard (401), the version-skew guard
// (409), and the onError backstop (500). Every route declares what it can
// actually emit — the envelope meta-test walks the spec to keep this honest.
const guardedRouteErrors = {
  400: errorResponse('Request validation failed (envelope code bad_request)'),
  401: errorResponse('Missing or unverifiable bearer token'),
  409: errorResponse('Client major version does not match the server (code version_skew)'),
  500: errorResponse('Unexpected server error — correlate via error.requestId'),
}

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  responses: {
    200: {
      description:
        'Liveness probe — no auth, no version gate; the desktop status indicator polls it',
      content: { 'application/json': { schema: HealthResponse } },
    },
    500: errorResponse('Unexpected server error — correlate via error.requestId'),
  },
})

const listNotesRoute = createRoute({
  method: 'get',
  path: '/api/notes',
  security: [{ Bearer: [] }],
  request: { query: NotesListQuery },
  responses: {
    200: {
      description:
        'One keyset page of the notes owned by the authenticated user (scoped by RLS), ' +
        'newest first; follow nextCursor until it is null',
      content: { 'application/json': { schema: NotesPage } },
    },
    ...guardedRouteErrors,
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
    ...guardedRouteErrors,
    413: errorResponse('Request body exceeds the 1 MiB /api/* limit'),
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
    ...guardedRouteErrors,
    404: errorResponse('No such note visible to this user'),
  },
})

const deleteNoteRoute = createRoute({
  method: 'delete',
  path: '/api/notes/{id}',
  security: [{ Bearer: [] }],
  request: { params: NoteParamsDto },
  responses: {
    204: { description: 'Note deleted' },
    ...guardedRouteErrors,
    404: errorResponse('No such note visible to this user'),
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

  // defaultHook: EVERY route's validation failure becomes the ApiError envelope.
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  // Error envelope wiring — no error path may bypass src/errors.ts.
  app.use(requestId)
  app.notFound(notFoundHandler)
  app.onError(onErrorHandler)

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
      return apiError(c, 401, 'unauthorized', 'missing bearer token')
    }
    try {
      const { userId } = await verifyToken(token)
      c.set('userId', userId)
    } catch {
      // Verification failures collapse to a bare 401: token errors must not leak
      // why a credential was rejected.
      return apiError(c, 401, 'unauthorized', 'invalid bearer token')
    }
    await next()
    return undefined
  }

  // Every /api/* route sits behind ALL THREE guards; /healthz and /openapi.json
  // are deliberately outside. The skew unit test walks app.routes to prove
  // coverage. Order matters: reject skewed/unauthenticated requests before the
  // body limit ever buffers a byte for them.
  app.use('/api/*', createSkewMiddleware(version))
  app.use('/api/*', requireAuth)
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      // Explicitly typed: bodyLimit's own onError context is untyped (any env).
      onError: (c: Context<AppEnv>) =>
        apiError(c, 413, 'payload_too_large', 'request body exceeds 1 MiB'),
    }),
  )

  app.openapi(listNotesRoute, async (c) => {
    const query = c.req.valid('query')
    const cursor = query.cursor === undefined ? undefined : decodeNotesCursor(query.cursor)
    if (cursor === null) {
      // Well-formed base64url that this server never minted — reject at the
      // edge, before the DAL sees it.
      return apiError(c, 400, 'bad_request', 'cursor is not a page token this server issued')
    }
    const page = await dal.list(c.get('userId'), { cursor, limit: query.limit })
    return c.json(page, 200)
  })

  app.openapi(createNoteRoute, async (c) => {
    const input: NewNote = c.req.valid('json')
    const note = await dal.create(c.get('userId'), input)
    return c.json(note, 201)
  })

  app.openapi(getNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const note = await dal.get(c.get('userId'), id)
    return note === null ? apiError(c, 404, 'not_found', 'no such note') : c.json(note, 200)
  })

  app.openapi(deleteNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const removed = await dal.remove(c.get('userId'), id)
    return removed ? c.body(null, 204) : apiError(c, 404, 'not_found', 'no such note')
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
