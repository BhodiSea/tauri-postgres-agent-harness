// `update` — pull the currently-fetched harness version into an installed
// project. Owned files upgrade when unmodified; local drift is preserved with
// the incoming version parked under .harness/pending/. Seeded files are never
// touched after init.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { planTree } from '../lib/copy.mjs'
import {
  fileMode,
  installerVersion,
  readManifest,
  sha256,
  writeManifest,
} from '../lib/manifest.mjs'
import { printReport } from '../lib/report.mjs'

export async function update(opts) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) {
    throw new Error('no .harness/manifest.json found — run `init` first')
  }

  const answers = manifest.answers
  const plan = [...planTree('base', answers)]
  for (const m of manifest.modules ?? []) {
    const entries = planTree(`modules/${m}`, answers)
    for (const e of entries) e.module = m
    plan.push(...entries)
  }
  // Stack files are all seeded (project-owned after init) — but new stack
  // files introduced by a newer template version should still be offered.
  plan.push(...planTree('stack', answers))

  const report = {
    conflicts: [],
    drift: [],
    notes: [],
    skipped: [],
    title: `harness update ${manifest.harnessVersion} → ${installerVersion()}`,
    written: [],
  }
  const files = { ...manifest.files }

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

    const currentSha = sha256(readFileSync(dest, 'utf8'))
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
    writeManifest(targetDir, { ...manifest, files, harnessVersion: installerVersion() })
  }
  return printReport(report, { json: opts.report === 'json' })
}

function write(dest, content) {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content, { mode: content.startsWith('#!') ? 0o755 : 0o644 })
}
