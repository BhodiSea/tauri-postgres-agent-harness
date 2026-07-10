#!/usr/bin/env node
// Gate: tauri-policy — pure-JSON asserts over the committed Tauri security surface.
// No cargo, no network, <100ms. What it enforces (and why it can never be vacuous:
// the scaffold ships all of these files, so absence = FAIL in CI, loud SKIP locally):
//   1. isolation pattern is on (app.security.pattern.use == "isolation")
//   2. CSP is non-null, default-src 'self', has a connect-src, no unsafe-eval
//   3. no dangerous* escape-hatch keys anywhere in tauri.conf.json
//   4. bundle identifier matches tools/identity.lock.json (installer upgrade identity
//      must never drift after first release)
//   5. WebView2 install mode stays offlineInstaller (enterprise/offline invariant)
//   6. capabilities grant no remote-URL IPC, no shell/process execution, no ** fs scopes
// SOURCE: docs/harness/README.md (tauri-policy gate) [corpus: tauri/isolation]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'tauri-policy'
const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const CAPS_DIR = 'apps/desktop/src-tauri/capabilities'
const LOCK = 'tools/identity.lock.json'

if (!existsSync(CONF)) skipOrFail(GATE, `${CONF} not found (no Tauri app surface yet)`)

let conf
try {
  conf = JSON.parse(readFileSync(CONF, 'utf8'))
} catch (e) {
  fail(GATE, `${CONF} is not valid JSON: ${e.message}`)
}

const errs = []

// 1. isolation pattern
const pattern = conf?.app?.security?.pattern
if (pattern?.use !== 'isolation') {
  errs.push(
    `app.security.pattern.use must be "isolation" (got ${JSON.stringify(pattern?.use)}) — brownfield needs an ADR + human HARNESS_ALLOW_SELF_EDIT approval`,
  )
}

// 2. CSP shape
const csp = conf?.app?.security?.csp
if (typeof csp !== 'string' || csp.length === 0) {
  errs.push('app.security.csp must be a non-empty string (null disables CSP entirely)')
} else {
  if (!/default-src[^;]*'self'/.test(csp)) errs.push("CSP must include default-src 'self'")
  if (!/connect-src/.test(csp)) errs.push('CSP must declare connect-src (pin the API origin)')
  if (/unsafe-eval/.test(csp)) errs.push("CSP must not allow 'unsafe-eval'")
}

// 3. dangerous* keys, recursively
;(function scan(obj, path) {
  if (obj === null || typeof obj !== 'object') return
  for (const [k, v] of Object.entries(obj)) {
    if (/^dangerous/i.test(k)) errs.push(`${path}${k}: dangerous* Tauri options are banned`)
    scan(v, `${path}${k}.`)
  }
})(conf, '')

// 4. identifier lock
if (existsSync(LOCK)) {
  try {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
    if (lock.identifier !== conf.identifier) {
      errs.push(
        `identifier drift: tauri.conf.json has "${conf.identifier}" but ${LOCK} pins "${lock.identifier}" — the bundle identifier is upgrade identity and must never change after release`,
      )
    }
  } catch (e) {
    errs.push(`${LOCK} unreadable: ${e.message}`)
  }
} else {
  errs.push(`${LOCK} missing — it pins the immutable bundle identifier`)
}

// 5. WebView2 install mode
const mode = conf?.bundle?.windows?.webviewInstallMode?.type
if (mode !== 'offlineInstaller') {
  errs.push(
    `bundle.windows.webviewInstallMode.type must be "offlineInstaller" (got ${JSON.stringify(mode)}) — downloadBootstrapper silently fails on egress-restricted machines`,
  )
}

// 6. capabilities
if (existsSync(CAPS_DIR)) {
  for (const f of readdirSync(CAPS_DIR).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(`${CAPS_DIR}/${f}`, 'utf8')
    let cap
    try {
      cap = JSON.parse(text)
    } catch (e) {
      errs.push(`capabilities/${f}: invalid JSON (${e.message})`)
      continue
    }
    if (cap.remote) errs.push(`capabilities/${f}: remote-URL capabilities are banned`)
    const perms = JSON.stringify(cap.permissions ?? [])
    if (/shell:allow-|process:allow-/.test(perms))
      errs.push(`capabilities/${f}: shell/process execution permissions are banned — add a typed #[tauri::command] instead`)
    if (/fs:(allow|scope)[^"]*\*\*/.test(perms))
      errs.push(`capabilities/${f}: '**' filesystem scopes are banned — scope to specific app dirs`)
  }
} else {
  errs.push(`${CAPS_DIR}/ missing — windows must declare least-privilege capabilities`)
}

failures(GATE, errs)
ok(GATE, 'isolation on, CSP pinned, identity locked, offline WebView2, least-privilege capabilities')
