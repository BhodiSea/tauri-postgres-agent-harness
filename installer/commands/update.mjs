// `update` — pull the currently-fetched harness version into an installed
// project. Owned files upgrade when unmodified; local drift is preserved with
// the incoming version parked under .harness/pending/. Seeded files are never
// touched after init — EXCEPT on explicit request: `update --refresh-seeded
// <path>` pulls the current template version of one seeded file (overwrite when
// untouched since install, park-on-drift when locally modified), so template
// improvements to project-owned exemplars can reach existing installs
// deliberately instead of never.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import { RETIRED_MODULES } from '../lib/layout.mjs'
import {
  fileMode,
  installerVersion,
  readManifest,
  sha256,
  writeManifest,
} from '../lib/manifest.mjs'
import {
  applyConfigCommandUpdates,
  applyConfigSteps,
  applyFileMigrations,
  readTemplateMigrations,
  versionsBetween,
} from '../lib/migrations.mjs'
import { printReport } from '../lib/report.mjs'

export async function update(opts, { migrations = readTemplateMigrations() } = {}) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) {
    throw new Error('no .harness/manifest.json found — run `init` first')
  }

  // Heal manifests written by pre-0.1.3 Windows installs, which keyed files
  // with backslashes: without this, every incoming POSIX path misses its
  // recorded entry and locally-modified files lose drift protection.
  manifest.files = Object.fromEntries(
    Object.entries(manifest.files ?? {}).map(([k, v]) => [k.split('\\').join('/'), v]),
  )

  const answers = manifest.answers
  const plan = [...planTree('base', answers)]
  for (const m of manifest.modules ?? []) {
    // A module retired by THIS update (promoted into base) has no template dir
    // anymore — its manifest entry is pruned by the promotedModules migration
    // below; planning it here would crash the very update that migrates it.
    if (RETIRED_MODULES.has(m)) continue
    const entries = planTree(`modules/${m}`, answers)
    for (const e of entries) e.module = m
    plan.push(...entries)
  }
  // Stack files are all seeded (project-owned after init) — but new stack
  // files introduced by a newer template version should still be offered.
  plan.push(...planTree('stack', answers))

  // Focused mode: refresh the requested SEEDED path(s) from the current
  // template and stop — no version migrations, no owned-file sweep.
  if (opts.refreshSeeded?.length) {
    return refreshSeeded({ targetDir, manifest, plan, paths: opts.refreshSeeded, opts })
  }

  const report = {
    conflicts: [],
    drift: [],
    notes: [],
    skipped: [],
    title: `harness update ${manifest.harnessVersion} → ${installerVersion()}`,
    written: [],
  }
  const files = { ...manifest.files }
  const modules = new Set(manifest.modules ?? [])

  // A newer template must never plan ZERO files — that is a packaging
  // regression (empty tarball, broken walker), and recording a version bump
  // over it would be a false-green update. Checked before anything mutates.
  if (plan.length === 0) {
    throw new Error('template plan is empty — refusing to record an update over a packaging regression')
  }

  // Version migrations FIRST: removals/renames prune stale files before the
  // plan loop writes the current tree, and gate promotions must reach the
  // consumer's harness.config.mjs (the Stop hook), not only CI's --min-floor.
  const pendingVersions = versionsBetween(migrations, manifest.harnessVersion, installerVersion())
  const migrationEntries = pendingVersions.map((v) => migrations[v])
  if (migrationEntries.length > 0) {
    applyFileMigrations({ targetDir, files, modules, report, entries: migrationEntries, dryRun: opts.dryRun })
    applyConfigSteps({ targetDir, files, report, entries: migrationEntries, dryRun: opts.dryRun })
    applyConfigCommandUpdates({ targetDir, files, report, entries: migrationEntries, dryRun: opts.dryRun })
  }

  for (const entry of plan) {
    const ip = entry.installPath
    if (ip === 'package.json') {
      // Merged only at init — never rewritten by update. Surface what a newer
      // template version would add or change so it isn't silently dropped.
      try {
        const incoming = JSON.parse(entry.content)
        const current = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
        for (const [name, cmd] of Object.entries(incoming.scripts ?? {})) {
          const existing = current.scripts?.[name] ?? current.scripts?.[`harness:${name}`]
          if (existing === undefined) report.notes.push(`new template script not installed: "${name}": ${JSON.stringify(cmd)} — add it manually`)
          else if (existing !== cmd) report.notes.push(`template script "${name}" changed upstream to ${JSON.stringify(cmd)} (yours kept)`)
        }
      } catch {
        report.notes.push('could not compare package.json scripts against the template')
      }
      continue
    }
    const dest = join(targetDir, ip)
    const recorded = manifest.files?.[ip]
    const mode = recorded?.mode ?? fileMode(ip)
    const incomingSha = sha256(entry.content)

    if (!existsSync(dest)) {
      if (opts.dryRun) {
        report.written.push(ip)
        continue
      }
      write(dest, entry.content)
      files[ip] = { mode, sha256: incomingSha, ...(entry.module ? { module: entry.module } : {}) }
      report.written.push(ip)
      continue
    }

    if (mode !== 'owned') {
      report.skipped.push(ip)
      continue
    }

    // Raw bytes, not utf8: hashing a lossy utf8 decode of a binary asset would
    // never match the manifest sha recorded over the true file content.
    const currentSha = sha256(readFileSync(dest))
    if (!recorded || currentSha === recorded.sha256) {
      if (currentSha === incomingSha) {
        report.skipped.push(ip)
        continue
      }
      if (opts.dryRun) {
        report.written.push(ip)
        continue
      }
      write(dest, entry.content)
      files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      report.written.push(ip)
      continue
    }

    // Local content already matches the incoming version (e.g. a fix was
    // applied by hand before updating): just re-record, no drift.
    if (currentSha === incomingSha) {
      if (!opts.dryRun) files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      report.skipped.push(ip)
      continue
    }

    // Local drift on an owned file: preserve it, park the incoming version.
    if (opts.force) {
      if (!opts.dryRun) {
        write(dest, entry.content)
        files[ip] = { ...(files[ip] ?? { mode }), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      report.notes.push(`--force overwrote locally-modified ${ip}`)
      continue
    }
    const pending = join('.harness', 'pending', ip)
    if (!opts.dryRun) write(join(targetDir, pending), entry.content)
    report.drift.push({ path: ip, pending })
  }

  if (!opts.dryRun) {
    writeManifest(targetDir, {
      ...manifest,
      files,
      modules: [...modules],
      harnessVersion: installerVersion(),
    })
  }
  return printReport(report, { json: opts.report === 'json' })
}

function write(dest, content) {
  mkdirSync(dirname(dest), { recursive: true })
  // Binary assets arrive as Buffers and are never executable.
  const executable = typeof content === 'string' && content.startsWith('#!')
  writeFileSync(dest, content, { mode: executable ? 0o755 : 0o644 })
}

// `update --refresh-seeded <path>`: the deliberate channel for template
// improvements to SEEDED (project-owned) surfaces. Unmodified-since-install →
// overwrite + re-record; locally modified → park the template version under
// .harness/pending/ (never clobber project work); unknown path → error naming
// nearby candidates so a typo cannot silently no-op.
function refreshSeeded({ targetDir, manifest, plan, paths, opts }) {
  const report = {
    conflicts: [],
    drift: [],
    notes: [],
    skipped: [],
    title: `refresh-seeded (template ${installerVersion()})`,
    written: [],
  }
  const files = { ...manifest.files }
  let failed = false

  for (const rawPath of paths) {
    const ip = rawPath.split('\\').join('/').replace(/^\.\//, '')
    const entry = plan.find((e) => e.installPath === ip)
    if (!entry) {
      const base = ip.split('/').at(-1)
      const near = plan
        .filter((e) => e.installPath.endsWith(`/${base}`) || e.installPath === base)
        .map((e) => e.installPath)
      report.notes.push(
        `no template file installs to ${ip}${near.length > 0 ? ` — did you mean: ${near.join(', ')}` : ''}`,
      )
      failed = true
      continue
    }
    const dest = join(targetDir, ip)
    const incomingRaw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content)
    const incomingSha = sha256(entry.content)
    const recorded = files[ip]
    const mode = recorded?.mode ?? fileMode(ip)

    if (!existsSync(dest)) {
      if (!opts.dryRun) {
        write(dest, entry.content)
        files[ip] = { ...(recorded ?? {}), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      continue
    }
    const currentRaw = readFileSync(dest)
    if (currentRaw.equals(incomingRaw)) {
      report.skipped.push(ip)
      report.notes.push(`${ip} already matches the current template`)
      continue
    }
    // Untouched since install (or --force): safe to refresh.
    if (opts.force || (recorded && sha256(currentRaw) === recorded.sha256)) {
      if (!opts.dryRun) {
        write(dest, entry.content)
        files[ip] = { ...(recorded ?? {}), mode, sha256: incomingSha }
      }
      report.written.push(ip)
      if (opts.force && recorded && sha256(currentRaw) !== recorded.sha256) {
        report.notes.push(`--force overwrote locally-modified ${ip}`)
      }
      continue
    }
    const pending = join('.harness', 'pending', ip)
    if (!opts.dryRun) write(join(targetDir, pending), entry.content)
    report.drift.push({ path: ip, pending })
    report.notes.push(
      `${ip} has local changes — kept; the current template version is parked at ${pending} (merge by hand, or re-run with --force)`,
    )
  }

  if (!opts.dryRun) writeManifest(targetDir, { ...manifest, files })
  const code = printReport(report, { json: opts.report === 'json' })
  return failed ? 1 : code
}
