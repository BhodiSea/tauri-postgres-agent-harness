// Can-fail proofs for the tauri-policy gate (template/base/tools/check-tauri-policy.mjs).
// Fixture-driven like the route-manifest suite: build a scaffold-shaped tree (the GREEN
// case uses the SHIPPED tauri.conf.json + identity.lock.json + capabilities/main.json
// verbatim, so template drift reds here), run the real gate with cwd inside it, assert
// the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-tauri-policy.mjs', import.meta.url),
)
const SHIPPED_CONF = readFileSync(
  fileURLToPath(
    new URL('../../template/stack/apps/desktop/src-tauri/tauri.conf.json', import.meta.url),
  ),
  'utf8',
)
const SHIPPED_LOCK = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/identity.lock.json', import.meta.url)),
  'utf8',
)
const SHIPPED_CAP = readFileSync(
  fileURLToPath(
    new URL(
      '../../template/stack/apps/desktop/src-tauri/capabilities/main.json',
      import.meta.url,
    ),
  ),
  'utf8',
)

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

// conf/lock/caps: string = verbatim file body, object = serialized, null = absent.
// caps is a { filename: content } map; null skips creating the capabilities dir.
function fixture({ conf = SHIPPED_CONF, lock = SHIPPED_LOCK, caps = { 'main.json': SHIPPED_CAP } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-tauripolicy-'))
  mkdirSync(join(dir, 'apps/desktop/src-tauri'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (conf !== null) writeFileSync(join(dir, 'apps/desktop/src-tauri/tauri.conf.json'), asText(conf))
  if (lock !== null) writeFileSync(join(dir, 'tools/identity.lock.json'), asText(lock))
  if (caps !== null) {
    mkdirSync(join(dir, 'apps/desktop/src-tauri/capabilities'), { recursive: true })
    for (const [name, body] of Object.entries(caps)) {
      writeFileSync(join(dir, 'apps/desktop/src-tauri/capabilities', name), asText(body))
    }
  }
  return dir
}

// Structural mutation of the shipped conf — no fragile string surgery on placeholders.
function confWith(mutate) {
  const c = JSON.parse(SHIPPED_CONF)
  mutate(c)
  return c
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped scaffold surface passes verbatim (conf + identity lock + capability)', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('tauri-policy: OK'), r.out)
  assert.ok(r.out.includes('isolation on, CSP pinned'), r.out)
})

test('RED: null or empty CSP fails — a disabled CSP is never acceptable', () => {
  const nul = runGate(fixture({ conf: confWith((c) => (c.app.security.csp = null)) }))
  assert.equal(nul.code, 1, nul.out)
  assert.ok(nul.out.includes('app.security.csp must be a non-empty string'), nul.out)

  const empty = runGate(fixture({ conf: confWith((c) => (c.app.security.csp = '')) }))
  assert.equal(empty.code, 1, empty.out)
  assert.ok(empty.out.includes('app.security.csp must be a non-empty string'), empty.out)
})

test("RED: CSP shape — default-src 'self' required, connect-src required, unsafe-eval banned", () => {
  const noSelf = runGate(
    fixture({ conf: confWith((c) => (c.app.security.csp = "default-src 'none'; connect-src 'self'")) }),
  )
  assert.equal(noSelf.code, 1, noSelf.out)
  assert.ok(noSelf.out.includes("CSP must include default-src 'self'"), noSelf.out)

  const noConnect = runGate(
    fixture({ conf: confWith((c) => (c.app.security.csp = "default-src 'self'")) }),
  )
  assert.equal(noConnect.code, 1, noConnect.out)
  assert.ok(noConnect.out.includes('CSP must declare connect-src'), noConnect.out)

  const evil = runGate(
    fixture({
      conf: confWith(
        (c) =>
          (c.app.security.csp =
            "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'"),
      ),
    }),
  )
  assert.equal(evil.code, 1, evil.out)
  assert.ok(evil.out.includes("CSP must not allow 'unsafe-eval'"), evil.out)
})

test('RED: CSP wildcard source tokens are each named with their directive (bare *, *.tld, scheme://*)', () => {
  const r = runGate(
    fixture({
      conf: confWith(
        (c) =>
          (c.app.security.csp =
            "default-src 'self'; img-src *; connect-src 'self' *.example.com https://*.evil.example"),
      ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('CSP img-src allows wildcard source "*"'), r.out)
  assert.ok(r.out.includes('CSP connect-src allows wildcard source "*.example.com"'), r.out)
  assert.ok(r.out.includes('CSP connect-src allows wildcard source "https://*.evil.example"'), r.out)
})

test('RED: plaintext-HTTP CSP origins red on non-loopback; GREEN on localhost/127.0.0.1', () => {
  const red = runGate(
    fixture({
      conf: confWith(
        (c) => (c.app.security.csp = "default-src 'self'; connect-src 'self' http://api.internal.example"),
      ),
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(
    red.out.includes('CSP connect-src allows plaintext-HTTP origin "http://api.internal.example"'),
    red.out,
  )

  const loopback = runGate(
    fixture({
      conf: confWith(
        (c) =>
          (c.app.security.csp =
            "default-src 'self'; connect-src 'self' http://localhost:1420 http://127.0.0.1:8787 http://localhost"),
      ),
    }),
  )
  assert.equal(loopback.code, 0, loopback.out)
})

test('RED: pattern.use must be "isolation" — wrong value and missing pattern both red, value quoted back', () => {
  const wrong = runGate(
    fixture({ conf: confWith((c) => (c.app.security.pattern.use = 'brownfield')) }),
  )
  assert.equal(wrong.code, 1, wrong.out)
  assert.ok(wrong.out.includes('app.security.pattern.use must be "isolation"'), wrong.out)
  assert.ok(wrong.out.includes('(got "brownfield")'), wrong.out)

  const missing = runGate(fixture({ conf: confWith((c) => delete c.app.security.pattern) }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('(got undefined)'), missing.out)
})

test('RED: any dangerous* key anywhere in the conf is named with its full path (case-insensitive, nested, arrays)', () => {
  const flat = runGate(
    fixture({
      conf: confWith((c) => (c.app.security.dangerousDisableAssetCspModification = true)),
    }),
  )
  assert.equal(flat.code, 1, flat.out)
  assert.ok(
    flat.out.includes(
      'app.security.dangerousDisableAssetCspModification: dangerous* Tauri options are banned',
    ),
    flat.out,
  )

  const inArray = runGate(
    fixture({ conf: confWith((c) => (c.app.windows[0].DangerousUseHttpScheme = true)) }),
  )
  assert.equal(inArray.code, 1, inArray.out)
  assert.ok(
    inArray.out.includes('app.windows.0.DangerousUseHttpScheme: dangerous* Tauri options are banned'),
    inArray.out,
  )
})

test('RED: identifier lock — drift names both identifiers; missing and unreadable lock both red', () => {
  const drift = runGate(fixture({ lock: { identifier: 'com.evil.other' } }))
  assert.equal(drift.code, 1, drift.out)
  assert.ok(drift.out.includes('identifier drift'), drift.out)
  assert.ok(drift.out.includes('"{{PRODUCT_IDENTIFIER}}"'), drift.out)
  assert.ok(drift.out.includes('"com.evil.other"'), drift.out)

  const missing = runGate(fixture({ lock: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(
    missing.out.includes('tools/identity.lock.json missing — it pins the immutable bundle identifier'),
    missing.out,
  )

  const unreadable = runGate(fixture({ lock: '{ nope' }))
  assert.equal(unreadable.code, 1, unreadable.out)
  assert.ok(unreadable.out.includes('tools/identity.lock.json unreadable'), unreadable.out)
})

test('RED: every window must declare a non-empty backgroundColor, named by index and label', () => {
  const absent = runGate(
    fixture({ conf: confWith((c) => delete c.app.windows[0].backgroundColor) }),
  )
  assert.equal(absent.code, 1, absent.out)
  assert.ok(absent.out.includes('app.windows[0] (label "main")'), absent.out)
  assert.ok(absent.out.includes('missing backgroundColor'), absent.out)

  const empty = runGate(
    fixture({ conf: confWith((c) => (c.app.windows[0].backgroundColor = '')) }),
  )
  assert.equal(empty.code, 1, empty.out)
  assert.ok(empty.out.includes('missing backgroundColor'), empty.out)
})

test('RED: webviewInstallMode must stay offlineInstaller — downloadBootstrapper and absence both red', () => {
  const boot = runGate(
    fixture({
      conf: confWith((c) => (c.bundle.windows.webviewInstallMode.type = 'downloadBootstrapper')),
    }),
  )
  assert.equal(boot.code, 1, boot.out)
  assert.ok(
    boot.out.includes('bundle.windows.webviewInstallMode.type must be "offlineInstaller"'),
    boot.out,
  )
  assert.ok(boot.out.includes('(got "downloadBootstrapper")'), boot.out)

  const absent = runGate(fixture({ conf: confWith((c) => delete c.bundle.windows) }))
  assert.equal(absent.code, 1, absent.out)
  assert.ok(absent.out.includes('(got undefined)'), absent.out)
})

test('RED: a capability with a remote block is banned, named by file', () => {
  const cap = JSON.parse(SHIPPED_CAP)
  cap.remote = { urls: ['https://api.example.com'] }
  const r = runGate(fixture({ caps: { 'main.json': cap } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('capabilities/main.json: remote-URL capabilities are banned'), r.out)
})

test('RED: shell/process execution permissions are banned — string and object permission forms', () => {
  const shellCap = JSON.parse(SHIPPED_CAP)
  shellCap.permissions = [...shellCap.permissions, 'shell:allow-execute']
  const shell = runGate(fixture({ caps: { 'main.json': shellCap } }))
  assert.equal(shell.code, 1, shell.out)
  assert.ok(
    shell.out.includes('capabilities/main.json: shell/process execution permissions are banned'),
    shell.out,
  )

  const procCap = JSON.parse(SHIPPED_CAP)
  procCap.permissions = [...procCap.permissions, { identifier: 'process:allow-exit' }]
  const proc = runGate(fixture({ caps: { 'main.json': procCap } }))
  assert.equal(proc.code, 1, proc.out)
  assert.ok(proc.out.includes('shell/process execution permissions are banned'), proc.out)
})

test("RED: '**' fs scope reds when the glob shares the fs: permission token", () => {
  const cap = JSON.parse(SHIPPED_CAP)
  cap.permissions = [...cap.permissions, 'fs:scope-$APPDATA/**']
  const r = runGate(fixture({ caps: { 'main.json': cap } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes("capabilities/main.json: '**' filesystem scopes are banned"),
    r.out,
  )
})

// KNOWN GAP (pinned current behavior, reported upstream): the gate's fs regex
// /fs:(allow|scope)[^"]*\*\*/ runs over JSON.stringify(permissions), and [^"]*
// cannot cross a JSON string boundary — so the realistic OBJECT form of a scoped
// permission ({"identifier":"fs:allow-read-text-file","allow":[{"path":"$HOME/**"}]})
// is NOT caught today. When the gate is fixed, flip this assertion to red.
test("KNOWN GAP: object-form fs permission with a '**' allow path currently passes the gate", () => {
  const cap = JSON.parse(SHIPPED_CAP)
  cap.permissions = [
    ...cap.permissions,
    { identifier: 'fs:allow-read-text-file', allow: [{ path: '$HOME/**' }] },
  ]
  const r = runGate(fixture({ caps: { 'main.json': cap } }))
  assert.equal(r.code, 0, r.out)
})

test('RED: broken capability JSON and a missing capabilities dir both fail loud, never open', () => {
  const broken = runGate(fixture({ caps: { 'main.json': SHIPPED_CAP, 'broken.json': '{ nope' } }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('capabilities/broken.json: invalid JSON'), broken.out)

  const noDir = runGate(fixture({ caps: null }))
  assert.equal(noDir.code, 1, noDir.out)
  assert.ok(
    noDir.out.includes('apps/desktop/src-tauri/capabilities/ missing'),
    noDir.out,
  )
})

test('RED: unparseable tauri.conf.json fails loud with the parse error', () => {
  const r = runGate(fixture({ conf: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tauri.conf.json is not valid JSON'), r.out)
})

test('errors accumulate: independent findings are all listed under one FAIL (n) header', () => {
  const r = runGate(
    fixture({
      conf: confWith((c) => {
        c.app.security.csp = null
        c.app.security.pattern.use = 'brownfield'
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tauri-policy: FAIL (2)'), r.out)
  assert.ok(r.out.includes('app.security.pattern.use must be "isolation"'), r.out)
  assert.ok(r.out.includes('app.security.csp must be a non-empty string'), r.out)
})

test('skip asymmetry: no tauri.conf.json → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-tauripolicy-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('FAIL'), ci.out)
})
