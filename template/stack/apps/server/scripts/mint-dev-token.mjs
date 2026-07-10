#!/usr/bin/env node
// Dev-auth minter for AUTH_MODE=stub (never used in production — the server
// refuses to boot with the stub verifier when NODE_ENV=production).
//
// Generates a fresh ES256 keypair, writes the PUBLIC keys to
// apps/server/.dev-auth/jwks.json (gitignored; the private key is never
// persisted), and prints a signed dev JWT for the seeded demo user. Values
// must stay in sync with STUB_ISSUER / STUB_AUDIENCE in src/auth/verify.ts.
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const DEV_USER_ID = '11111111-1111-4111-8111-111111111111'
const STUB_ISSUER = 'urn:app:dev-auth'
const STUB_AUDIENCE = 'urn:app:api'
const TOKEN_TTL_SECONDS = 8 * 60 * 60 // one working day; re-run to re-mint

const { subtle } = webcrypto
const encoder = new TextEncoder()
const b64url = (data) => Buffer.from(data).toString('base64url')

const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])
const kid = randomUUID()
const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey)
const jwks = { keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] }

const outDir = new URL('../.dev-auth/', import.meta.url)
await mkdir(outDir, { recursive: true })
const jwksUrl = new URL('jwks.json', outDir)
await writeFile(jwksUrl, `${JSON.stringify(jwks, null, 2)}\n`)

const now = Math.floor(Date.now() / 1000)
const header = { alg: 'ES256', typ: 'JWT', kid }
const payload = {
  iss: STUB_ISSUER,
  aud: STUB_AUDIENCE,
  sub: DEV_USER_ID,
  iat: now,
  exp: now + TOKEN_TTL_SECONDS,
}
const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
// SOURCE: JWS ES256 signatures are the raw r||s concatenation (RFC 7518 §3.4), which is
// exactly what WebCrypto ECDSA emits — no DER conversion needed [corpus: entra/jwt-verify]
const signature = await subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  keyPair.privateKey,
  encoder.encode(signingInput),
)
const token = `${signingInput}.${b64url(signature)}`

console.log(`wrote ${fileURLToPath(jwksUrl)}`)
console.log(`dev token for user ${DEV_USER_ID} (expires in ${String(TOKEN_TTL_SECONDS / 3600)}h):`)
console.log(token)
