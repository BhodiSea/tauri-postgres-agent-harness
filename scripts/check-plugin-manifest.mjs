#!/usr/bin/env node
// Static structural validation of the Claude Code plugin manifests
// (.claude-plugin/plugin.json + marketplace.json): required fields present and
// every referenced agents/commands/skills path actually exists in the repo —
// a plugin shipping dangling paths is dead on install, and nothing else
// checks this surface (version equality is check-release-lockstep's job).
//   usage: node scripts/check-plugin-manifest.mjs [repo-root]
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const errs = []

function load(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    errs.push(`${rel}: missing`)
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    errs.push(`${rel}: invalid JSON (${e.message})`)
    return null
  }
}

const plugin = load('.claude-plugin/plugin.json')
if (plugin !== null) {
  for (const field of ['name', 'version', 'description']) {
    if (typeof plugin[field] !== 'string' || plugin[field].trim() === '') {
      errs.push(`plugin.json: missing/empty ${field}`)
    }
  }
  if (typeof plugin.version === 'string' && !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    errs.push(`plugin.json: version "${plugin.version}" is not plain x.y.z`)
  }
  for (const agent of Array.isArray(plugin.agents) ? plugin.agents : []) {
    if (!existsSync(join(ROOT, agent))) errs.push(`plugin.json agents: ${agent} does not exist`)
  }
  for (const field of ['commands', 'skills']) {
    if (typeof plugin[field] === 'string' && !existsSync(join(ROOT, plugin[field]))) {
      errs.push(`plugin.json ${field}: ${plugin[field]} does not exist`)
    }
  }
}

const marketplace = load('.claude-plugin/marketplace.json')
if (marketplace !== null) {
  if (typeof marketplace.name !== 'string' || marketplace.name.trim() === '') {
    errs.push('marketplace.json: missing/empty name')
  }
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  if (plugins.length === 0) errs.push('marketplace.json: plugins must be a non-empty array')
  for (const [i, entry] of plugins.entries()) {
    for (const field of ['name', 'source', 'description']) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        errs.push(`marketplace.json plugins[${i}]: missing/empty ${field}`)
      }
    }
  }
  if (plugin !== null && plugins[0]?.name !== plugin.name) {
    errs.push('marketplace.json plugins[0].name must match plugin.json name')
  }
}

if (errs.length > 0) {
  console.error(`PLUGIN MANIFEST: ${errs.length} problem(s):`)
  for (const e of errs) console.error(`  ${e}`)
  process.exit(1)
}
console.log('PLUGIN MANIFEST: CLEAN')
