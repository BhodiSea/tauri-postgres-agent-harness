// `doctor` — integrity + wiring check for an installed harness. Read-only;
// CI-friendly exit codes (0 clean, 1 broken, 2 drift/attention).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManifest, sha256 } from '../lib/manifest.mjs'

export async function doctor(opts) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  const errors = []
  const warnings = []

  if (!manifest) {
    console.error('doctor: no .harness/manifest.json — run `init` first')
    return 1
  }

  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) errors.push(`node ${process.versions.node} < required 22`)

  for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
    const dest = join(targetDir, ip)
    if (!existsSync(dest)) {
      ;(meta.mode === 'owned' || meta.mode === 'config' ? errors : warnings).push(`missing: ${ip} (${meta.mode})`)
      continue
    }
    if (meta.mode === 'seeded') continue
    // Hash raw bytes (manifest hashes are computed over the written content —
    // Buffers for binary assets); decode to text only for the hook-stamp probe.
    const raw = readFileSync(dest)
    const text = raw.toString('utf8')
    const current = sha256(raw)
    if (current !== meta.sha256) {
      if (meta.mode === 'config') {
        warnings.push(`config tuned since install: ${ip} (expected — verify the change was human-approved)`)
      } else if (ip.startsWith('.claude/hooks/')) {
        // Distinguish "stale hook from an older harness" from "locally modified":
        // hooks carry a HARNESS_HOOK_VERSION stamp the installer rewrites on update.
        const stamp = text.match(/HARNESS_HOOK_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
        if (stamp && stamp !== manifest.harnessVersion) {
          warnings.push(`stale hook: ${ip} carries v${stamp}, manifest is v${manifest.harnessVersion} (run \`update\`)`)
        } else {
          warnings.push(`locally modified hook: ${ip} (restore it or run \`update\` — hooks are harness-owned)`)
        }
      } else {
        warnings.push(`drift on harness-owned file: ${ip} (run \`update\` to reconcile, or restore it)`)
      }
    }
  }

  // Gate wiring.
  try {
    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
    const v = pkg.scripts?.validate ?? pkg.scripts?.['harness:validate']
    if (!v || !v.includes('tools/validate.mjs')) errors.push('package.json validate script no longer runs tools/validate.mjs')
  } catch {
    errors.push('unreadable package.json')
  }
  try {
    const settings = JSON.parse(readFileSync(join(targetDir, '.claude/settings.json'), 'utf8'))
    const hookText = JSON.stringify(settings.hooks ?? {})
    for (const h of ['pretool-bash-guard', 'pretool-write-guard', 'posttool-source-check', 'stop-validate-gate']) {
      if (!hookText.includes(h)) errors.push(`.claude/settings.json no longer wires ${h}`)
    }
  } catch {
    errors.push('unreadable .claude/settings.json')
  }
  try {
    const cfg = await import(pathToFileURL(join(targetDir, 'tools/harness.config.mjs')).href)
    if (!Array.isArray(cfg.VALIDATE_STEPS) || cfg.VALIDATE_STEPS.length === 0) errors.push('tools/harness.config.mjs exports no VALIDATE_STEPS')
    if (!Array.isArray(cfg.STOP_HOOK_STEPS) || cfg.STOP_HOOK_STEPS.length === 0) errors.push('tools/harness.config.mjs exports no STOP_HOOK_STEPS')
  } catch (err) {
    errors.push(`tools/harness.config.mjs failed to import: ${err.message}`)
  }
  // AGENTS.md is canonical project memory; CLAUDE.md must stay a pure
  // `@AGENTS.md` include so the two can never diverge (CI asserts equality).
  try {
    const claudeMd = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8').trim()
    if (claudeMd !== '@AGENTS.md') {
      warnings.push('CLAUDE.md is no longer a pure `@AGENTS.md` include — content belongs in AGENTS.md')
    }
  } catch {
    // absent files are reported via the manifest loop
  }
  for (const probe of ['AGENTS.md', '.github/CODEOWNERS']) {
    try {
      if (/\{\{[A-Z0-9_]+\}\}/.test(readFileSync(join(targetDir, probe), 'utf8')))
        warnings.push(`${probe} still contains unrendered {{placeholders}}`)
    } catch {
      // absent files are reported via the manifest loop
    }
  }

  for (const e of errors) console.error(`  ERROR ${e}`)
  for (const w of warnings) console.warn(`  warn  ${w}`)
  if (errors.length === 0 && warnings.length === 0) console.log('doctor: CLEAN')
  return errors.length ? 1 : warnings.length ? 2 : 0
}
