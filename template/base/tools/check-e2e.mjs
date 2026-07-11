#!/usr/bin/env node
// Gate: e2e — the agent-time Playwright lane. Runs the WHOLE e2e/ directory
// (a11y + degraded-network + states) through the root playwright.config.ts:
// chromium against `vite dev`, Tauri IPC mocked, API stubbed — exactly what the
// quality-gate e2e job runs in CI, so an agent turn cannot end green while the
// browser suite is red.
//
// Chromium detection is playwright's own registry fact, not subprocess vibes:
// resolve @playwright/test from the project root (createRequire) and check
// chromium.executablePath() exists on disk — the same path the runner validates
// at launch. `playwright install --dry-run` output is a human-readable format,
// not a contract, and it never states whether the browser is ALREADY installed;
// probing the browsers directory by hand would re-implement (and drift from)
// playwright's per-version registry layout. Browser absent → loud local skip
// with the exact install command; CI → fail closed.
//
// The lane must never wedge the validate chain: hard kill after TIMEOUT_MS with
// a loud message, and the last TAIL_LINES of playwright output surface on any
// failure so the red is debuggable from the gate log alone.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fail, MAX_BUFFER, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'e2e'
const TIMEOUT_MS = 10 * 60 * 1000
const TAIL_LINES = 50

if (!existsSync('playwright.config.ts') || !existsSync('e2e')) {
  skipOrFail(GATE, 'no e2e surface (playwright.config.ts + e2e/ not found)')
}

let chromiumPath = null
try {
  const requireFromRoot = createRequire(`${process.cwd()}/package.json`)
  const { chromium } = requireFromRoot('@playwright/test')
  chromiumPath = chromium.executablePath()
} catch {
  skipOrFail(GATE, '@playwright/test not resolvable from the project root (run pnpm install)')
}
if (typeof chromiumPath !== 'string' || !existsSync(chromiumPath)) {
  skipOrFail(GATE, 'chromium browser not installed — run `pnpm exec playwright install chromium`')
}

const res = spawnSync('pnpm exec playwright test', {
  shell: true, // pnpm is a .cmd shim on Windows; the config decides workers/reporter
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
  killSignal: 'SIGKILL',
  maxBuffer: MAX_BUFFER,
  env: process.env,
})

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
const tail = out.split('\n').slice(-TAIL_LINES).join('\n')

if (res.error !== undefined && res.error.code === 'ETIMEDOUT') {
  console.error(tail)
  fail(
    GATE,
    `playwright run KILLED after ${String(TIMEOUT_MS / 60000)} minutes — the e2e lane must never hang the gate chain (a dev server may be orphaned on port 1420; last ${String(TAIL_LINES)} lines above)`,
  )
}
if (res.status !== 0) {
  console.error(tail)
  fail(
    GATE,
    `playwright test failed (exit ${String(res.status)}) — last ${String(TAIL_LINES)} lines above`,
  )
}

// Anti-vacuity: a runner that ran nothing must never read as green.
const passed = Number(out.match(/(\d+) passed/)?.[1] ?? '0')
if (passed === 0) {
  console.error(tail)
  fail(
    GATE,
    'playwright exited 0 but reported no passing tests — an empty e2e run is a vacuous pass',
  )
}
ok(
  GATE,
  `${String(passed)} e2e test(s) green (chromium fast lane: a11y + states + degraded-network)`,
)
