// `enable <module>` / `disable <module>` — flip an opt-in module's files.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import { MODULES } from '../lib/layout.mjs'
import { fileMode, readManifest, sha256, writeManifest } from '../lib/manifest.mjs'

const GATE_MODULES_NEEDING_CONFIG = new Map([
  ['gate-styleguide', "uncomment the ['styleguide', ...] line in tools/harness.config.mjs"],
  ['gate-perf-budget', "uncomment the ['perf-budget', ...] line in tools/harness.config.mjs"],
])

export async function enable(opts, moduleName, on) {
  if (!MODULES.includes(moduleName)) {
    throw new Error(`unknown module: ${moduleName} (known: ${MODULES.join(', ')})`)
  }
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) throw new Error('no .harness/manifest.json — run `init` first')

  const modules = new Set(manifest.modules ?? [])
  const files = { ...manifest.files }

  if (on) {
    for (const entry of planTree(`modules/${moduleName}`, manifest.answers)) {
      const dest = join(targetDir, entry.installPath)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.content, { mode: entry.content.startsWith('#!') ? 0o755 : 0o644 })
      files[entry.installPath] = { mode: fileMode(entry.installPath), sha256: sha256(entry.content), module: moduleName }
      console.log(`  + ${entry.installPath}`)
    }
    modules.add(moduleName)
    const hint = GATE_MODULES_NEEDING_CONFIG.get(moduleName)
    if (hint) console.log(`\nTo activate the gate: ${hint} (harness-protected — a human sets HARNESS_ALLOW_SELF_EDIT=1 or edits outside an agent session).`)
  } else {
    for (const [ip, meta] of Object.entries(files)) {
      if (meta.module !== moduleName) continue
      const dest = join(targetDir, ip)
      if (existsSync(dest)) {
        const current = sha256(readFileSync(dest, 'utf8'))
        if (current !== meta.sha256) {
          console.warn(`  kept locally-modified ${ip} (remove manually if intended)`)
          delete files[ip]
          continue
        }
        rmSync(dest)
      }
      delete files[ip]
      console.log(`  - ${ip}`)
    }
    modules.delete(moduleName)
  }

  writeManifest(targetDir, { ...manifest, modules: [...modules], files })
  return 0
}
