#!/usr/bin/env node
// Gate: gate-integrity — the enforcement surface on disk still matches the sha256
// hashes .harness/manifest.json recorded at install/update time, so a raw write
// that slipped past the write-guard hook (shell redirection, sed -i, an external
// editor) into a gate script, hook, or the settings surface reds the very next
// validate run. Scope: manifest entries that are harness-OWNED and inside the
// gate surface (tools/, .claude/hooks/, .claude/settings.json, the RLS and
// migration runners). 'config' and 'seeded' entries are skipped — they are
// human-tunable, and `update` re-records config hashes on sanctioned changes.
// Static and <200ms: raw-byte sha256 recompute only, no subprocesses, no deps.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'gate-integrity'
const MANIFEST = '.harness/manifest.json'

// The enforcement surface (mirrors the write-guard's blanket-protected paths
// wherever the manifest records harness ownership).
const SURFACE = [
  /^tools\//,
  /^\.claude\/hooks\//,
  /^\.claude\/settings\.json$/,
  /^tests\/rls\/run-rls\.mjs$/,
  /^tests\/migrations\/migration-apply\.mjs$/,
]

if (!existsSync(MANIFEST)) skipOrFail(GATE, 'no .harness/manifest.json (not an installed harness)')

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MANIFEST} is not valid JSON (${e.message}) — restore it from git history (do NOT re-run \`init\`)`,
  )
}

const errs = []
let checked = 0
for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
  if (meta?.mode !== 'owned') continue // config + seeded are human-tunable by design
  if (!SURFACE.some((re) => re.test(ip))) continue
  checked += 1
  if (!existsSync(ip)) {
    errs.push(`${ip}: missing from disk (the manifest records it as harness-owned)`)
    continue
  }
  // RAW bytes — the installer hashes the exact content it writes.
  const current = createHash('sha256').update(readFileSync(ip)).digest('hex')
  if (current !== meta.sha256) {
    errs.push(`${ip}: sha256 mismatch against ${MANIFEST} (tampered or hand-edited)`)
  }
}

// A manifest that records zero owned enforcement files is itself mangled — a
// gate that verifies nothing must never read as green.
if (checked === 0) {
  fail(GATE, `${MANIFEST} records no harness-owned enforcement files — restore it from git history`)
}

failures(
  GATE,
  errs,
  'Restore the file(s) from git; if the change came from a sanctioned harness upgrade, re-run `npx tauri-postgres-agent-harness update` (it re-records the hashes).',
)
ok(GATE, `${checked} harness-owned enforcement file(s) match their recorded hashes`)
