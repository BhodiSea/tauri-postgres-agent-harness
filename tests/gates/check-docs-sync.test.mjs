// Can-fail proofs for the docs-sync gate: the agent-facing docs cannot lie
// about the chain. Fixtures render a minimal AGENTS.md/CLAUDE.md/package.json
// against the SHIPPED harness.config.mjs (copied in), so the gate's parse of
// the real config is under test, not a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const AGENTS_TEMPLATE = fileURLToPath(new URL('../../template/base/AGENTS.md', import.meta.url))
const CATALOG_TEMPLATE = fileURLToPath(
  new URL('../../template/base/docs/harness/gates-catalog.md', import.meta.url),
)

// The REAL shipped scripts (placeholders neutralized) — the GREEN case must
// prove the shipped AGENTS.md against the shipped package surface.
const SHIPPED_SCRIPTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../template/base/package.json.tmpl', import.meta.url)), 'utf8')
    .replace(/\{\{[A-Z0-9_]+\}\}/g, 'x'),
).scripts

// The shipped catalog is the canonical fixture for the catalog-lockstep check,
// exactly like the shipped AGENTS.md is for the gate-list check. `catalog: null`
// simulates a deleted catalog; `manifest` (an object) plants .harness/manifest.json
// for the version-ramp cases.
function fixture({ agents, claude = '@AGENTS.md\n', scripts = SHIPPED_SCRIPTS, catalog = shippedCatalog, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-docs-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'harness.config.mjs'), join(dir, 'tools/harness.config.mjs'))
  cpSync(join(TOOLS, 'check-docs-sync.mjs'), join(dir, 'tools/check-docs-sync.mjs'))
  writeFileSync(join(dir, 'AGENTS.md'), agents)
  writeFileSync(join(dir, 'CLAUDE.md'), claude)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  if (catalog !== null) {
    mkdirSync(join(dir, 'docs/harness'), { recursive: true })
    writeFileSync(join(dir, 'docs/harness/gates-catalog.md'), catalog)
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

const shippedCatalog = readFileSync(CATALOG_TEMPLATE, 'utf8')

function runGate(dir) {
  const res = spawnSync('node', ['tools/check-docs-sync.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// The shipped AGENTS.md is the canonical fixture — extract its real gate-list
// sentence so these tests track the template instead of hand-copying it.
const shippedAgents = readFileSync(AGENTS_TEMPLATE, 'utf8')

test('GREEN: the shipped AGENTS.md gate list matches the shipped VALIDATE_STEPS', () => {
  const r = runGate(fixture({ agents: shippedAgents }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('lockstep'), r.out)
})

test('RED: a drifted gate list names the documented vs actual chains', () => {
  const drifted = shippedAgents.replace('`docs-sync`', '`docs-sync`, `imaginary-gate`')
  const r = runGate(fixture({ agents: drifted }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drifted from VALIDATE_STEPS'), r.out)
})

test('RED: a wrong gate COUNT fails even when the names parse', () => {
  const wrongCount = shippedAgents.replace(/The (\d+) gates, in order:/, 'The 7 gates, in order:')
  const r = runGate(fixture({ agents: wrongCount }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('update the count'), r.out)
})

test('RED: impure CLAUDE.md and an advertised script that does not exist', () => {
  const impure = runGate(fixture({ agents: shippedAgents, claude: '@AGENTS.md\nextra doctrine here\n' }))
  assert.equal(impure.code, 1, impure.out)
  assert.ok(impure.out.includes('pure'), impure.out)

  const ghost = runGate(
    fixture({ agents: shippedAgents, scripts: { test: 'vitest run', 'test:rls': 'x' } }),
  )
  assert.equal(ghost.code, 1, ghost.out)
  assert.ok(ghost.out.includes('`pnpm validate`'), ghost.out)
})

// ── catalog lockstep (v0.1.5): every VALIDATE_STEPS name needs its numbered
// `### <n>. <name> — ` section in docs/harness/gates-catalog.md. ──

test('RED: renaming a numbered catalog section reds the catalog-lockstep sub-check', () => {
  const renamed = shippedCatalog.replace(
    /^### (\d+)\. perf-budget — /m,
    '### $1. perf-fudget — ',
  )
  assert.notEqual(renamed, shippedCatalog, 'fixture must actually rename a section')
  const r = runGate(fixture({ agents: shippedAgents, catalog: renamed }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("gate 'perf-budget' has no section"), r.out)
  assert.ok(r.out.includes('FIX[docs-sync]:'), r.out)
})

test('RED: a deleted catalog file fails naming the owned doc; module/runner sections never satisfy the check', () => {
  const gone = runGate(fixture({ agents: shippedAgents, catalog: null }))
  assert.equal(gone.code, 1, gone.out)
  assert.ok(gone.out.includes('docs/harness/gates-catalog.md missing'), gone.out)

  // Strip every NUMBERED heading but keep the un-numbered sections (Stop-hook
  // suites, the validate-runner note, opt-in modules): all 22 steps must red —
  // proof the pinned grammar cannot be satisfied by a non-step section.
  const unnumbered = shippedCatalog.replace(/^### \d+\. [a-z0-9-]+ — .*$/gm, '')
  const r = runGate(fixture({ agents: shippedAgents, catalog: unnumbered }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("gate 'format' has no section"), r.out)
  assert.ok(r.out.includes("gate 'docs-sync' has no section"), r.out)
})

test('RAMP: a pre-0.1.5 baseVersion downgrades a catalog miss to NOTE + pass; 0.1.5 manifests stay live', () => {
  const renamed = shippedCatalog.replace(/^### (\d+)\. perf-budget — /m, '### $1. perf-fudget — ')

  // An updated 0.1.4 consumer (no baseVersion field yet — harnessVersion is the
  // fallback): the miss surfaces as NOTEs, the gate stays green.
  const ramped = runGate(
    fixture({ agents: shippedAgents, catalog: renamed, manifest: { harnessVersion: '0.1.4', files: {} } }),
  )
  assert.equal(ramped.code, 0, ramped.out)
  assert.ok(ramped.out.includes('NOTE'), ramped.out)
  assert.ok(ramped.out.includes('baseVersion'), ramped.out)
  assert.ok(ramped.out.includes("gate 'perf-budget' has no section"), ramped.out)

  // A graduated (or fresh) install is live: same injection, real red.
  const live = runGate(
    fixture({
      agents: shippedAgents,
      catalog: renamed,
      manifest: { harnessVersion: '0.1.5', baseVersion: '0.1.5', files: {} },
    }),
  )
  assert.equal(live.code, 1, live.out)
  assert.ok(live.out.includes("gate 'perf-budget' has no section"), live.out)
})
