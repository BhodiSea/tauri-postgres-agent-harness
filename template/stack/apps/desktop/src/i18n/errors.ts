import { ApiRequestError, UnauthenticatedError } from '../lib/api-client'
import type { MessageKey } from './catalog'
import { t } from './index'

// Turning a failure into copy a HUMAN can read.
//
// Before 0.1.6 every error surface in the app rendered `error.message` straight to the user.
// That string is whatever the server or the fetch layer happened to produce — "request failed
// (500)", "not signed in", "Failed to fetch", a Postgres driver message on a bad day. It is
// English, it is untranslatable (it arrives at runtime, from another process), and it is not
// written for the person reading it.
//
// The error envelope already carries the thing that IS a contract: a stable `code` enum
// (@app/schema ApiError). That is what the client localizes. The server's `message` stays
// visible — but as a technical DETAIL beneath the translated copy, next to the requestId,
// where it belongs: it is for the person reading the support ticket, not the person filing it.
// SOURCE: the error envelope's `code` is the stable machine-readable contract clients switch
// on; `message` is for humans and logs [corpus: harness/doctrine]

// One key per ApiError code. Exhaustive by construction: `satisfies` makes a new server code
// with no catalog entry a COMPILE error, not a silently-untranslated string in production.
const BY_CODE = {
  bad_request: 'error.api.bad_request',
  unauthorized: 'error.api.unauthorized',
  not_found: 'error.api.not_found',
  payload_too_large: 'error.api.payload_too_large',
  version_skew: 'error.api.version_skew',
  internal: 'error.api.internal',
} as const satisfies Record<string, MessageKey>

export interface UserFacingError {
  /** Translated copy — what the user is actually asked to read. */
  readonly message: string
  /** The raw underlying message. A technical detail, shown quietly; never the headline. */
  readonly detail: string | null
  /** Correlates this failure with the server's logs. */
  readonly requestId: string | null
}

/**
 * Translate any thrown value into user-facing copy. Never throws, never returns an empty
 * string: a failure that cannot be described is still a failure the user must be told about.
 */
export function translateError(cause: unknown): UserFacingError {
  if (cause instanceof UnauthenticatedError) {
    return { message: t('error.api.unauthorized'), detail: null, requestId: null }
  }
  if (cause instanceof ApiRequestError) {
    const key = cause.code === null ? undefined : BY_CODE[cause.code as keyof typeof BY_CODE]
    const message = key === undefined ? t('error.api.unknown', { status: cause.status }) : t(key)
    return { message, detail: cause.message, requestId: cause.requestId }
  }
  // A network failure, an abort, a bug: the fetch never produced an envelope. "Could not reach
  // the server" is honest about the only thing we actually know.
  return {
    message: t('error.api.offline'),
    detail: cause instanceof Error ? cause.message : String(cause),
    requestId: null,
  }
}
