// `init` — bootstrap a new project or retrofit an existing one.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import { detect, detectContext } from '../lib/detect.mjs'
import { CONFLICTABLE, MODULES, RETROFIT_ADDITIVE, TIERS } from '../lib/layout.mjs'
import { fileMode, installerVersion, sha256, writeManifest } from '../lib/manifest.mjs'
import { mergePackageJson } from '../lib/merge-package-json.mjs'
import { mergeWorkspaceYaml } from '../lib/merge-workspace-yaml.mjs'
import { printReport } from '../lib/report.mjs'
import { collectAnswers, parseSets } from '../lib/prompts.mjs'

export async function init(opts) {
  const targetDir = opts.dir
  mkdirSync(targetDir, { recursive: true })

  if (opts.consume) {
    // Template-repo path: consume the local checkout into a project in place.
    rmSync(join(targetDir, '.github'), { recursive: true, force: true })
  }

  const det = opts.consume ? { mode: 'bootstrap' } : detect(targetDir)
  const ctx = detectContext(targetDir)
  const answers = await collectAnswers({ yes: opts.yes, sets: parseSets(opts.set), ctx })

  const modules = opts.modules ?? TIERS[opts.tier] ?? []
  for (const m of modules) {
    if (!MODULES.includes(m)) throw new Error(`unknown module: ${m} (known: ${MODULES.join(', ')})`)
  }

  const plan = [...planTree('base', answers), ...planTree('stack', answers)]
  // Fail loud, never fail open: an unreadable template tree must be an error,
  // not a 0-file "successful" install (Windows URL.pathname regression class).
  if (plan.length === 0) {
    throw new Error('template tree resolved to zero files — installer packaging is broken')
  }
  for (const m of modules) {
    const entries = planTree(`modules/${m}`, answers)
    for (const e of entries) e.module = m
    plan.push(...entries)
  }

  const report = { title: `harness init (${det.mode})`, written: [], skipped: [], conflicts: [], drift: [], notes: [] }
  const files = {}

  // package.json first: on retrofit we merge without clobbering (a colliding "validate"
  // stays the project's; ours lands at harness:validate). The Stop hook is unaffected —
  // it invokes `node tools/validate.mjs` directly, not the package.json script name.
  const pkgEntry = plan.find((e) => e.installPath === 'package.json')
  const wsEntry = plan.find((e) => e.installPath === 'pnpm-workspace.yaml')
  const rest = plan.filter(
    (e) =>
      e.installPath !== 'package.json' &&
      e.installPath !== 'pnpm-workspace.yaml' &&
      !e.installPath.startsWith('.harness/'),
  )

  if (pkgEntry) {
    const incoming = JSON.parse(pkgEntry.content)
    if (det.mode === 'retrofit') {
      const existing = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
      const { merged, report: mergeReport } = mergePackageJson(existing, incoming)
      pkgEntry.content = `${JSON.stringify(merged, null, 2)}\n`
      for (const r of mergeReport) {
        if (r.kind === 'script-conflict')
          report.conflicts.push({ name: `package.json#scripts.${r.name}`, detail: `kept yours; harness version at scripts.harness:${r.name}` })
        if (r.kind === 'dep-mismatch')
          report.notes.push(`dependency ${r.name}: project has ${r.existing}, harness tested with ${r.tested}`)
      }
    }
  }

  // pnpm-workspace.yaml is MERGED on retrofit (globs unioned, catalog pins
  // added-when-missing) because a .harness.yaml sibling would be inert — the
  // gates need our globs/pins active. Exotic YAML falls back to the sibling
  // path with a manual-merge conflict, never a clobber.
  if (wsEntry && det.mode === 'retrofit' && existsSync(join(targetDir, 'pnpm-workspace.yaml'))) {
    const existingText = readFileSync(join(targetDir, 'pnpm-workspace.yaml'), 'utf8')
    const res = mergeWorkspaceYaml(existingText, wsEntry.content)
    if (res === null) {
      const sibling = 'pnpm-workspace.harness.yaml'
      if (!opts.dryRun) write(join(targetDir, sibling), wsEntry.content)
      report.conflicts.push({ path: 'pnpm-workspace.yaml', detail: `could not auto-merge (exotic YAML); harness version at ${sibling} — merge manually` })
      report.written.push(sibling)
      wsEntry.content = null // handled; skip in main loop
    } else {
      wsEntry.content = res.merged
      for (const r of res.report) {
        if (r.kind === 'catalog-mismatch')
          report.notes.push(`catalog pin ${r.name}: project has ${r.existing}, harness tested with ${r.tested} (kept yours)`)
      }
    }
  }

  for (const entry of [
    ...(pkgEntry ? [pkgEntry] : []),
    ...(wsEntry && wsEntry.content !== null ? [wsEntry] : []),
    ...rest,
  ]) {
    const ip = entry.installPath
    const dest = join(targetDir, ip)
    const isStack = entry.storagePath.startsWith('stack/')

    if (det.mode === 'retrofit' && isStack && ip !== 'package.json') {
      if (!RETROFIT_ADDITIVE.has(ip)) {
        report.skipped.push(ip)
        continue
      }
      if (existsSync(dest)) {
        report.skipped.push(ip)
        continue
      }
    }

    if (det.mode === 'retrofit') {
      const conflictable = CONFLICTABLE.find((c) => c.installed === ip)
      if (conflictable && existsSync(dest) && readFileSync(dest, 'utf8') !== entry.content) {
        const sibling = ip.replace(/(\.[a-z]+)$/, '.harness$1')
        if (!opts.dryRun) write(join(targetDir, sibling), entry.content)
        report.conflicts.push({ path: ip, detail: `existing config kept; harness version at ${sibling} — merge manually` })
        report.written.push(sibling)
        continue
      }
    }

    if (opts.dryRun) {
      report.written.push(ip)
      continue
    }
    write(dest, entry.content)
    report.written.push(ip)
    files[ip] = { mode: fileMode(ip), sha256: sha256(entry.content) }
    if (entry.module) files[ip].module = entry.module
  }

  if (!opts.dryRun) {
    writeManifest(targetDir, {
      harnessVersion: installerVersion(),
      installedAt: opts.now ?? new Date().toISOString(),
      mode: det.mode,
      tier: opts.tier ?? 'standard',
      modules,
      answers,
      files,
    })
  }

  if (opts.consume) {
    for (const d of ['installer', 'template', 'scripts', 'tests', '.claude-plugin']) {
      rmSync(join(targetDir, d), { recursive: true, force: true })
    }
    report.notes.push('consumed template checkout in place — installer/template trees removed')
  }

  report.notes.push(
    'next: pnpm install && git init (if new) — then `pnpm validate` must be green before any agent turn ends',
  )
  if (det.mode === 'retrofit') {
    report.notes.push('review .harness sibling configs and merge them into your existing configs')
  }
  return printReport(report, { json: opts.report === 'json' })
}

function write(dest, content) {
  mkdirSync(dirname(dest), { recursive: true })
  // Hooks/scripts with shebangs are invoked directly by Claude Code — they
  // need the executable bit, which writeFileSync would otherwise drop.
  // Binary assets arrive as Buffers and are never executable.
  const executable = typeof content === 'string' && content.startsWith('#!')
  writeFileSync(dest, content, { mode: executable ? 0o755 : 0o644 })
}
