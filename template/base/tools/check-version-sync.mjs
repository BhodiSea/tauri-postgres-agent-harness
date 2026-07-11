#!/usr/bin/env node
// Gate: version-sync — one version, everywhere, and rc-churn tools pinned exactly.
//   1. root package.json / tauri.conf.json / apps/server / apps/desktop versions match
//      (the skew middleware compares x-client-version majors — a drifted manifest
//      would make the desktop lie about itself)
//   2. .nvmrc / .node-version / engines.node agree on the Node major
//   3. babel-plugin-react-compiler and other rc-tier tools are EXACT-pinned in the
//      catalog (a caret on an rc tool flaps regenerate-and-diff gates repo-wide)
//   4. zod resolves to exactly one version across the workspace (two instances break
//      instanceof checks in @hono/zod-openapi with incomprehensible errors)
// SOURCE: docs/harness/README.md (version-sync gate) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { failures, inCI, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'version-sync'
const errs = []

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
if (!existsSync('package.json')) skipOrFail(GATE, 'no root package.json')

const root = readJson('package.json')
const versions = { 'package.json': root.version }
for (const [label, path, pick] of [
  ['tauri.conf.json', 'apps/desktop/src-tauri/tauri.conf.json', (j) => j.version],
  ['apps/server', 'apps/server/package.json', (j) => j.version],
  ['apps/desktop', 'apps/desktop/package.json', (j) => j.version],
]) {
  if (existsSync(path)) versions[label] = pick(readJson(path))
}
const distinct = new Set(Object.values(versions).filter(Boolean))
if (distinct.size > 1) {
  errs.push(
    `version drift: ${Object.entries(versions)
      .map(([k, v]) => `${k}=${v ?? 'MISSING'}`)
      .join(', ')} — bump them together`,
  )
}

// Node version agreement (major)
const majors = new Map()
if (existsSync('.nvmrc')) majors.set('.nvmrc', readFileSync('.nvmrc', 'utf8').trim())
if (existsSync('.node-version'))
  majors.set('.node-version', readFileSync('.node-version', 'utf8').trim())
if (root.engines?.node) majors.set('engines.node', root.engines.node)
const nodeMajors = new Set(
  [...majors.values()].map((v) => (v.match(/(\d+)/) ?? [])[1]).filter(Boolean),
)
if (nodeMajors.size > 1) {
  errs.push(
    `node version disagreement: ${[...majors.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`,
  )
}

// Exact pins for rc-churn tools in the workspace catalog
if (existsSync('pnpm-workspace.yaml')) {
  const ws = readFileSync('pnpm-workspace.yaml', 'utf8')
  for (const tool of ['babel-plugin-react-compiler', 'drizzle-kit', '@tauri-apps/cli']) {
    const m = ws.match(new RegExp(`['"]?${tool.replace('/', '\\/')}['"]?:\\s*(\\S+)`))
    if (m && /^[\^~]/.test(m[1])) {
      errs.push(
        `catalog pin for ${tool} is ${m[1]} — rc/major-churn tools must be EXACT-pinned (Renovate bumps them deliberately)`,
      )
    }
  }
}

// Single zod instance across the workspace (requires an install; skip honestly without one)
if (existsSync('node_modules')) {
  try {
    const out = execSync('pnpm list -r --depth Infinity zod --json', {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const found = new Set()
    ;(function collect(node) {
      if (Array.isArray(node)) return node.forEach(collect)
      if (node && typeof node === 'object') {
        if (node.dependencies?.zod?.version) found.add(node.dependencies.zod.version)
        if (node.devDependencies?.zod?.version) found.add(node.devDependencies.zod.version)
        for (const v of Object.values(node.dependencies ?? {})) collect(v)
        for (const v of Object.values(node.devDependencies ?? {})) collect(v)
      }
    })(JSON.parse(out))
    if (found.size > 1) {
      errs.push(
        `zod resolves to ${found.size} versions (${[...found].join(', ')}) — catalog-pin it so exactly one instance exists (instanceof breaks otherwise)`,
      )
    }
  } catch (e) {
    // A silent pass here would vacate the single-instance assert exactly where
    // it matters. Partial local installs may legitimately break `pnpm list`;
    // CI (full install) must never swallow it.
    if (inCI()) {
      errs.push(
        `pnpm list failed — cannot verify the single-zod-instance invariant: ${(e.stderr?.toString() ?? e.message).slice(0, 300)}`,
      )
    } else {
      console.log(
        `${GATE}: NOTE — zod single-instance check skipped (pnpm list failed on this partial install; CI verifies it)`,
      )
    }
  }
}

failures(GATE, errs)
ok(GATE, `version ${root.version} in lockstep; node majors agree; rc tools exact-pinned`)
