import { describe, expect, it } from 'vitest'
import { type CrashEvent, redactCrashEvent, redactText } from './redact.js'

// Redaction policy tests (crash-reporting module). These run in the default
// vitest unit lane the moment the module is enabled — the policy is enforced
// BEFORE any crash transport exists. Extend the fixtures with every PII shape
// your deployment handles (student identifiers, tenant names, …): a redaction
// test that only covers generic shapes undertests YOUR data.

describe('redactText', () => {
  it('strips userinfo from credentialed connection strings', () => {
    expect(redactText('db failed: postgres://app_api:postgres@127.0.0.1:5432/app timeout')).toBe(
      'db failed: postgres://[redacted]@127.0.0.1:5432/app timeout',
    )
    expect(redactText('cache at redis://svc:hunter2@cache.internal:6379/0')).toBe(
      'cache at redis://[redacted]@cache.internal:6379/0',
    )
  })

  it('strips bearer tokens and JWT-shaped blobs', () => {
    expect(redactText('header was Bearer abc.def-123')).toBe('header was Bearer [redacted]')
    expect(redactText('token eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln leaked')).toBe(
      'token [redacted-jwt] leaked',
    )
  })

  it('strips e-mail addresses and home-directory usernames', () => {
    expect(redactText('user jane.doe@example.edu reported')).toBe('user [redacted-email] reported')
    expect(redactText('at C:\\Users\\jdoe\\AppData\\Roaming\\app\\logs')).toBe(
      'at C:\\Users\\[redacted]\\AppData\\Roaming\\app\\logs',
    )
    expect(redactText('read /home/jdoe/.config/app')).toBe('read /home/[redacted]/.config/app')
  })

  it('leaves ordinary diagnostics untouched', () => {
    const message = 'ECONNREFUSED 127.0.0.1:5432 after 3000ms (attempt 2)'
    expect(redactText(message)).toBe(message)
  })
})

describe('redactCrashEvent', () => {
  it('redacts message, stack, and string context values', () => {
    const event: CrashEvent = {
      message: 'probe by admin@example.com failed',
      stack: 'Error: at C:\\Users\\jdoe\\app\\main.js:1',
      context: { note: 'retrying as admin@example.com' },
    }
    const out = redactCrashEvent(event)
    expect(out.message).toBe('probe by [redacted-email] failed')
    expect(out.stack).toBe('Error: at C:\\Users\\[redacted]\\app\\main.js:1')
    expect(out.context).toEqual({ note: 'retrying as [redacted-email]' })
  })

  it('drops values under secret-shaped keys wholesale, at any nesting depth', () => {
    const event: CrashEvent = {
      message: 'boot',
      context: {
        config: {
          apiKey: 'k-123',
          authorization: 'whatever',
          harmless: 'keep-me',
          nested: { session_token: ['a', 'b'] },
        },
      },
    }
    expect(redactCrashEvent(event).context).toEqual({
      config: {
        apiKey: '[redacted]',
        authorization: '[redacted]',
        harmless: 'keep-me',
        nested: { session_token: '[redacted]' },
      },
    })
  })

  it('passes non-string primitives through unchanged', () => {
    const event: CrashEvent = {
      message: 'tick',
      context: { attempt: 3, degraded: true, latencyMs: 41.5, none: null },
    }
    expect(redactCrashEvent(event).context).toEqual({
      attempt: 3,
      degraded: true,
      latencyMs: 41.5,
      none: null,
    })
  })

  it('omits absent optional fields instead of materializing them', () => {
    const out = redactCrashEvent({ message: 'plain' })
    expect(out).toEqual({ message: 'plain' })
    expect('stack' in out).toBe(false)
    expect('context' in out).toBe(false)
  })
})
