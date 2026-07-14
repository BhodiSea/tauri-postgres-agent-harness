import { ApiError } from '@app/schema'

// THE one door to the API server. Every request the desktop makes goes through
// apiFetch — origin, bearer token, and error-envelope decoding live here and nowhere
// else, so an authenticated call is what an agent gets by DEFAULT rather than
// something it must remember to assemble at each call site.
//
// Why this module exists: each feature used to call `fetch()` directly with only a
// content-type header. Against the real server every one of them 401s — and nothing
// caught it, because every unit test and the whole e2e lane mocks the network. The seam
// between the two halves of the app was the one surface no gate exercised
// (e2e/integration.spec.ts now owns it).
//
// The token is INJECTED (main.tsx wires src/auth/host-token.ts), not read here: it lives
// in the Tauri host, never in the webview. A `VITE_`-prefixed token name is compiled into
// the shipped bundle — the write-guard bans the name outright — and webview storage is
// readable by any injected script.
// SOURCE: Tauri 2 security model — the webview is an untrusted client; the API server on
// FORCE RLS is the authorization boundary [corpus: tauri/capabilities]

// Dev override via Vite env; otherwise the API origin baked into the committed CSP
// (tauri.conf.json connect-src) at install time. Declared ONCE — a second copy is how a
// screen ends up talking to the wrong origin.
//
// `||`, NOT `??`: a SET-BUT-EMPTY var must fall back too. `??` only catches null/undefined,
// so a bare `VITE_API_ORIGIN=` line (env.example ships exactly that line) yields '', every
// request silently becomes a SAME-ORIGIN relative path against the dev server, and the 404s
// read as a server fault. The same nullish-vs-empty confusion disabled audience validation
// outright in apps/server/src/auth/verify.ts. Empty means unset.
const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN || '{{API_ORIGIN}}'

/** Resolves the bearer token, or null when the session is unauthenticated. */
type AccessTokenProvider = () => Promise<string | null>

// Unauthenticated until wired. main.tsx installs the host-backed provider at startup;
// the unit suite and the e2e mock install their own. A forgotten wire therefore fails
// LOUDLY on the first request (UnauthenticatedError) instead of silently sending a bare
// one and reading as a server fault.
let tokenProvider: AccessTokenProvider = () => Promise.resolve(null)

/** Install the token source. Called once at startup (and by tests). */
export function setAccessTokenProvider(next: AccessTokenProvider): void {
  tokenProvider = next
}

/**
 * A failed API call, carrying the server envelope's own message. The server speaks ONE
 * error shape (`{ error: { code, message, requestId } }`) — decoding it in one place is
 * what lets every surface show the real reason, and quote a requestId, instead of a bare
 * status code.
 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string | null

  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

/** No token: the request is never sent. A bare request 401s and reads as a server fault. */
export class UnauthenticatedError extends Error {
  constructor() {
    super('not signed in')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * Decode the server's error envelope. A non-envelope body (a proxy's HTML 502, a
 * truncated response) still yields a usable message rather than a parse crash.
 */
async function envelopeError(response: Response): Promise<ApiRequestError> {
  try {
    const { error } = ApiError.parse(await response.json())
    return new ApiRequestError(error.message, response.status, error.code, error.requestId ?? null)
  } catch {
    return new ApiRequestError(
      `request failed (${String(response.status)})`,
      response.status,
      null,
      null,
    )
  }
}

export interface ApiFetchInit extends RequestInit {
  /** Liveness probes (/healthz) are the only unauthenticated calls. */
  readonly auth?: boolean
}

/**
 * Fetch against the API. Attaches `Authorization: Bearer <token>` unless `auth: false`,
 * and REJECTS rather than sending an unauthenticated request. Non-2xx responses throw an
 * ApiRequestError carrying the envelope message, so call sites branch on failure once.
 */
export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  const { auth = true, headers, ...rest } = init
  const merged = new Headers(headers)

  if (auth) {
    const token = await tokenProvider()
    if (token === null || token === '') throw new UnauthenticatedError()
    merged.set('authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_ORIGIN}${path}`, { ...rest, headers: merged })
  if (!response.ok) throw await envelopeError(response)
  return response
}

/** apiFetch + a JSON body, with the content-type the server's zod validator requires. */
export async function apiPost(
  path: string,
  body: unknown,
  init: ApiFetchInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return apiFetch(path, { ...init, method: 'POST', headers, body: JSON.stringify(body) })
}
