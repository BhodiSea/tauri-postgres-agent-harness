// .harness/manifest.json — the machine record of what the harness owns.
// Hashes are computed over post-render content, so per-project placeholder
// values do not read as drift. SOURCE: docs/harness/README.md (tamper evidence)
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_FILES, SEEDED_FILES, SEEDED_PREFIXES } from './layout.mjs'

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function fileMode(installPath) {
  if (CONFIG_FILES.has(installPath)) return 'config'
  if (SEEDED_FILES.has(installPath)) return 'seeded'
  if (SEEDED_PREFIXES.some((p) => installPath.startsWith(p))) return 'seeded'
  return 'owned'
}

export function manifestPath(targetDir) {
  return join(targetDir, '.harness', 'manifest.json')
}

export function readManifest(targetDir) {
  try {
    return JSON.parse(readFileSync(manifestPath(targetDir), 'utf8'))
  } catch {
    return null
  }
}

export function writeManifest(targetDir, manifest) {
  const path = manifestPath(targetDir)
  mkdirSync(dirname(path), { recursive: true })
  const ordered = {
    harnessVersion: manifest.harnessVersion,
    installedAt: manifest.installedAt,
    mode: manifest.mode,
    tier: manifest.tier,
    modules: [...manifest.modules].sort(),
    answers: manifest.answers,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))),
  }
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`)
}

export function installerVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return pkg.version
}
