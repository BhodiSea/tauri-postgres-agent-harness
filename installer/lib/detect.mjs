// Target-directory detection: bootstrap (empty / no package.json) vs
// retrofit (existing pnpm monorepo with a Tauri desktop app and/or Hono
// server). Single-root layouts are rejected in v1 — every gate, glob, and
// boundary rule assumes the pnpm workspace shape (apps/*, packages/*).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

export function detect(targetDir) {
  const pkgPath = join(targetDir, 'package.json')
  if (!existsSync(pkgPath)) {
    const entries = existsSync(targetDir)
      ? readdirSync(targetDir).filter((e) => e !== '.git' && e !== '.DS_Store')
      : []
    return { mode: 'bootstrap', empty: entries.length === 0 }
  }
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    throw new Error(`unreadable package.json at ${pkgPath}`)
  }
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (allDeps.next) {
    throw new Error(
      'target depends on `next` — this harness is for Tauri 2 + Hono pnpm monorepos. ' +
        'For Next.js + Supabase projects use github:BhodiSea/next-supabase-agent-harness instead.',
    )
  }
  for (const lock of ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    if (existsSync(join(targetDir, lock))) {
      throw new Error(
        `${lock} detected — the harness requires pnpm (every gate invokes \`pnpm exec\`, ` +
          'and the workspace catalog pins the toolchain). Migrate to pnpm first: ' +
          'remove the lockfile, add packageManager to package.json, run `pnpm import` (npm) or `pnpm install`.',
      )
    }
  }
  if (!existsSync(join(targetDir, 'pnpm-workspace.yaml'))) {
    throw new Error(
      'no pnpm-workspace.yaml — v1 retrofits pnpm monorepos only (apps/*, packages/*). ' +
        'Every gate glob, knip workspace map, tsconfig project reference, and boundary rule ' +
        'assumes the workspace shape. Either adopt the monorepo layout first, or bootstrap a ' +
        'fresh scaffold and move your code into it.',
    )
  }
  const hasTauri = existsSync(join(targetDir, 'apps/desktop/src-tauri/tauri.conf.json'))
  const hasHono = Boolean(allDeps.hono) || existsSync(join(targetDir, 'apps/server/package.json'))
  if (!hasTauri && !hasHono) {
    throw new Error(
      'workspace found, but neither apps/desktop/src-tauri/tauri.conf.json nor an apps/server ' +
        'Hono app is present — the harness targets Tauri 2 desktop + Hono server monorepos. ' +
        'If your workspace uses different app paths, v1 cannot retrofit it; track the ' +
        'configurable-layout fast-follow in the harness repo.',
    )
  }
  return { mode: 'retrofit', pkg, hasTauri, hasHono }
}

export function detectContext(targetDir) {
  const ctx = { dirName: basename(targetDir), gitOwner: null, answers: {} }
  try {
    const url = execFileSync('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const m = url.match(/[:/]([^/:]+)\/[^/]+?(\.git)?$/)
    if (m) ctx.gitOwner = m[1]
  } catch {
    // no git remote — defaults cover it
  }
  return ctx
}
