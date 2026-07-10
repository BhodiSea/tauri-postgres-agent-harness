# Patch: server crash reporting (self-hosted Sentry)

OPT-IN wiring for `apps/server`. Nothing here is applied automatically — copy the
snippets deliberately, after your self-hosted Sentry (or GlitchTip) instance
exists. The redaction policy (`src/crash/redact.ts`, shipped by this module with
tests) is the non-negotiable part; the transport below is replaceable.

## 1. Install (server workspace)

```
pnpm --filter server add @sentry/node
```

Pin it in the workspace catalog like every other dependency
(`pnpm-workspace.yaml`), then reference `catalog:` from `apps/server/package.json`.

## 2. Environment contract (`.env.example` additions)

```ini
# ---- crash reporting (crash-reporting module) ---------------------------------
# Self-hosted Sentry ingest DSN. Empty = crash reporting disabled (the default).
# On-prem doctrine: events go to YOUR ingest host, never a third-party SaaS.
SENTRY_DSN=
# Release tag; set from CI so events map to a build. Default: package version.
SENTRY_RELEASE=
```

## 3. Wiring (`apps/server/src/instrument.ts`, imported FIRST in `src/index.ts`)

```ts
import * as Sentry from '@sentry/node'
import { redactCrashEvent, redactText } from './crash/redact.js'

// SOURCE: crash-reporting module — every outbound event passes the tested
// redaction boundary; an unset DSN disables the transport entirely
// [corpus: harness/doctrine]
const dsn = process.env['SENTRY_DSN']
if (dsn !== undefined && dsn !== '') {
  Sentry.init({
    dsn,
    release: process.env['SENTRY_RELEASE'],
    // No default PII: request bodies, cookies, and user context stay home.
    sendDefaultPii: false,
    beforeSend(event) {
      // Reuse the unit-tested policy for the fields Sentry actually sends.
      if (event.message !== undefined) event.message = redactText(event.message)
      for (const exception of event.exception?.values ?? []) {
        if (exception.value !== undefined) exception.value = redactText(exception.value)
      }
      if (event.extra !== undefined) {
        event.extra = redactCrashEvent({ message: '', context: event.extra }).context
      }
      return event
    },
  })
}
```

## 4. Route-level capture

Hono's `app.onError` is the single funnel — capture there, then rethrow/return
the sanitized 500. Never capture inside handlers (double-reporting, missed
middleware errors).

## 5. Prove the redaction path (anti-vacuity)

With a local `mitmdump` (or Sentry's dev ingest) as the DSN target, throw a test
error containing a credentialed connection string (the dev-shaped
`postgres://app_api:postgres@127.0.0.1/app` works) + an e-mail address, and
assert the captured payload contains `[redacted]` and `[redacted-email]` — the
unit tests prove the functions; this proves the WIRING calls them.
