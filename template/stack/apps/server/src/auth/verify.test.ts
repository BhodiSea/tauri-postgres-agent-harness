import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  assertAuthBootSafety,
  createTokenVerifier,
  STUB_AUDIENCE,
  STUB_ISSUER,
  type TokenVerifier,
} from './verify.js'

const DEV_USER_ID = '11111111-1111-1111-1111-111111111111'

interface MintOptions {
  iss?: string
  aud?: string
  sub?: string
  exp?: number
  nbf?: number
}

let mint: (opts?: MintOptions) => Promise<string>
let verify: TokenVerifier
const nowSeconds = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  // Same shape scripts/mint-dev-token.mjs produces: local JWKS file + ES256 tokens.
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  const dir = await mkdtemp(join(tmpdir(), 'dev-auth-test-'))
  const jwksPath = join(dir, 'jwks.json')
  await writeFile(
    jwksPath,
    JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] }),
  )
  verify = createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: jwksPath })
  mint = async (opts = {}) => {
    const now = nowSeconds()
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(opts.iss ?? STUB_ISSUER)
      .setAudience(opts.aud ?? STUB_AUDIENCE)
      .setSubject(opts.sub ?? DEV_USER_ID)
      .setIssuedAt(now - 60)
      .setExpirationTime(opts.exp ?? now + 3600)
    if (opts.nbf !== undefined) {
      jwt.setNotBefore(opts.nbf)
    }
    return jwt.sign(privateKey)
  }
})

describe('stub-mode verification (byte-identical path to entra mode)', () => {
  it('round-trips a token minted against the local JWKS', async () => {
    await expect(verify(await mint())).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('accepts a token that expired 4 minutes ago (clockTolerance 300s)', async () => {
    await expect(verify(await mint({ exp: nowSeconds() - 240 }))).resolves.toEqual({
      userId: DEV_USER_ID,
    })
  })

  it('rejects a token that expired 6 minutes ago', async () => {
    await expect(verify(await mint({ exp: nowSeconds() - 360 }))).rejects.toThrow()
  })

  it('accepts a token that becomes valid 4 minutes from now', async () => {
    await expect(verify(await mint({ nbf: nowSeconds() + 240 }))).resolves.toEqual({
      userId: DEV_USER_ID,
    })
  })

  it('rejects a token that becomes valid 6 minutes from now', async () => {
    await expect(verify(await mint({ nbf: nowSeconds() + 360 }))).rejects.toThrow()
  })

  it('rejects a wrong audience', async () => {
    await expect(verify(await mint({ aud: 'urn:someone:else' }))).rejects.toThrow()
  })

  it('rejects a wrong issuer', async () => {
    await expect(verify(await mint({ iss: 'urn:someone:else' }))).rejects.toThrow()
  })

  it('rejects a subject that is not a uuid (RLS identity must be a uuid)', async () => {
    await expect(verify(await mint({ sub: 'admin' }))).rejects.toThrow()
  })
})

describe('boot safety', () => {
  it('is fatal to boot production with the stub verifier', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production', AUTH_MODE: 'stub' })
    }).toThrow(/AUTH_MODE=stub is forbidden/)
  })

  it('is fatal to boot production with AUTH_MODE unset (stub is the default)', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production' })
    }).toThrow(/AUTH_MODE=stub is forbidden/)
  })

  it('allows production with entra and dev with stub', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production', AUTH_MODE: 'entra' })
    }).not.toThrow()
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'development', AUTH_MODE: 'stub' })
    }).not.toThrow()
  })

  it('rejects unknown AUTH_MODE values at verifier construction', () => {
    expect(() => createTokenVerifier({ AUTH_MODE: 'none' })).toThrow(/unknown AUTH_MODE/)
  })

  it('requires tenant configuration in entra mode', () => {
    expect(() => createTokenVerifier({ AUTH_MODE: 'entra' })).toThrow(/ENTRA_TENANT_ID/)
  })
})
