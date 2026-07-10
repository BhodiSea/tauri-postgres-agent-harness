// Crash-report redaction (crash-reporting module). Every event that leaves the
// process — Sentry beforeSend, a user-triggered diagnostics bundle, shipped log
// excerpts — passes through here FIRST. The wiring patches in
// docs/modules/crash-reporting/ plug these functions into the transport; this
// module is dependency-free so the policy is unit-testable without any SDK.
// SOURCE: harness doctrine — crash pipelines are exfiltration paths until proven
// otherwise; redaction is enforced at the boundary, in code, with tests
// [corpus: harness/doctrine]

export interface CrashEvent {
  readonly message: string
  readonly stack?: string
  readonly context?: Readonly<Record<string, unknown>>
}

// Keys whose VALUES are always dropped wholesale, regardless of shape.
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|authorization|cookie|api[-_]?key|credential|dsn/i

// Shape-based scrubbers for free text (messages, stacks, string values).
const TEXT_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // Credentialed connection strings: keep the scheme, drop the userinfo.
  [/\b(postgres(?:ql)?|mysql|redis|amqp):\/\/[^@\s'"]+@/gi, '$1://[redacted]@'],
  // Authorization header material and JWT-shaped blobs.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted-jwt]'],
  // E-mail addresses (usernames are PII in an on-prem deployment).
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]'],
  // Home directories carry the OS username (Windows profile + Linux home).
  [/[A-Za-z]:\\Users\\[^\\\s'"]+/g, 'C:\\Users\\[redacted]'],
  [/\/home\/[^/\s'"]+/g, '/home/[redacted]'],
]

export function redactText(text: string): string {
  let out = text
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => redactValue(key, item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(k, v)]),
    )
  }
  return value
}

export function redactCrashEvent(event: CrashEvent): CrashEvent {
  const redacted: { message: string; stack?: string; context?: Record<string, unknown> } = {
    message: redactText(event.message),
  }
  if (event.stack !== undefined) {
    redacted.stack = redactText(event.stack)
  }
  if (event.context !== undefined) {
    redacted.context = Object.fromEntries(
      Object.entries(event.context).map(([k, v]) => [k, redactValue(k, v)]),
    )
  }
  return redacted
}
