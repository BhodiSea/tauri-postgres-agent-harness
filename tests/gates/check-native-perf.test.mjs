// Can-fail proofs for the native perf floor (template/base/tools/check-native-perf.mjs).
//
// Two things are being proven here, and they are different in kind:
//
//   CLOSURE (Stop-chain, static) — every #[tauri::command] has a bench and a budget. This is
//   what makes the gate a floor instead of a note about whichever commands happened to ship
//   with the scaffold. Without it, benches only ever cover the exemplar and the command an
//   agent adds next week is unmeasured host cost.
//
//   MEASUREMENT (CI, after cargo bench) — each subject's criterion mean, expressed as a RATIO
//   to the cheapest command, is inside its committed cap. The ratio is the whole design: raw
//   nanoseconds on a shared runner vary 27-40% run-to-run, which is enough to make an absolute
//   budget either flaky or useless.
//
// Both are driven with synthetic Rust source and synthetic criterion JSON — no cargo, no
// toolchain, no minutes-long bench run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../../template/base/tools/check-native-perf.mjs', import.meta.url),
)
const GATE_LIB_DIR = fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url))

const CRATE = 'apps/desktop/src-tauri'

const libRs = (commands) =>
  commands
    .map(
      (name) => `#[tauri::command]
#[specta::specta]
fn ${name}() -> String {
    String::new()
}
`,
    )
    .join('\n')

const benchRs = (commands) =>
  `const COMMANDS: &[&str] = &[${commands.map((c) => `"${c}"`).join(', ')}];\n`

const budgetJson = (subjects, extra = {}) => ({
  normalizer: { subject: 'ipc/app_version', maxNanos: 10_000 },
  subjects,
  ...extra,
})

/**
 * A project tree the gate can run against: lib.rs (the command surface), benches/host.rs (the
 * bench list), the budget, and optionally criterion's estimates. Omitting `estimates` models a
 * local turn where nobody ran `cargo bench`.
 * @param {{ commands: string[], benched?: string[] | null, subjects?: object, budget?: object | null, estimates?: Record<string, number>, manifest?: object }} opts
 */
function project({ commands, benched = commands, subjects, budget, estimates, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), 'native-perf-'))
  mkdirSync(join(dir, 'tools', 'lib'), { recursive: true })
  cpSync(GATE_LIB_DIR, join(dir, 'tools', 'lib'), { recursive: true })

  mkdirSync(join(dir, CRATE, 'src'), { recursive: true })
  writeFileSync(join(dir, CRATE, 'src', 'lib.rs'), libRs(commands))

  if (benched !== null) {
    mkdirSync(join(dir, CRATE, 'benches'), { recursive: true })
    writeFileSync(join(dir, CRATE, 'benches', 'host.rs'), benchRs(benched))
  }

  const effective = budget === undefined ? budgetJson(subjects ?? {}) : budget
  if (effective !== null) {
    writeFileSync(
      join(dir, 'tools', 'native-perf-budget.json'),
      JSON.stringify(effective, null, 2),
    )
  }

  for (const [id, nanos] of Object.entries(estimates ?? {})) {
    const out = join(dir, CRATE, 'target', 'criterion', ...id.split('/'), 'new')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'estimates.json'),
      JSON.stringify({ mean: { point_estimate: nanos } }),
    )
  }

  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

/**
 * gate.mjs splits its streams — ok()/NOTE go to stdout, fail()/failures() to stderr — so
 * every assertion below reads the two joined. A test that only watched stdout would see an
 * empty string on exactly the failures it exists to prove.
 */
function run(dir, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

// --- closure ---------------------------------------------------------------

test('closure: passes when every command is benched and budgeted', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /closure OK — 2 #\[tauri::command\]/)
})

test('closure: a command with no bench is FATAL — the whole point of the gate', () => {
  const dir = project({
    commands: ['app_version', 'recent_files'],
    benched: ['app_version'],
    subjects: {},
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 1)
  assert.match(r.out, /`recent_files` is a #\[tauri::command\] with no bench/)
})

test('closure: a benched command with no budget entry is FATAL', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: {}, // access_token is benched but unbudgeted
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 1)
  assert.match(r.out, /`ipc\/access_token` is benched but has no budget/)
})

test('closure: a stale COMMANDS entry (bench names a command that no longer exists) reds', () => {
  const dir = project({
    commands: ['app_version'],
    benched: ['app_version', 'deleted_command'],
    subjects: { 'ipc/deleted_command': { maxRatio: 2 } },
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 1)
  assert.match(r.out, /stale entry \(the bench would panic\)/)
})

test('closure: deleting benches/host.rs outright reds — it cannot be disarmed by removal', () => {
  const dir = project({ commands: ['app_version'], benched: null, subjects: {} })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 1)
  assert.match(r.out, /does not exist/)
})

test('a crate with no #[tauri::command] at all is genuinely nothing to measure', () => {
  const dir = project({ commands: [], benched: [], subjects: {} })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 0)
  assert.match(r.out, /no #\[tauri::command\]/)
})

test('a helper fn near a command is not itself a command (the attribute anchors the match)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-perf-'))
  mkdirSync(join(dir, 'tools', 'lib'), { recursive: true })
  cpSync(GATE_LIB_DIR, join(dir, 'tools', 'lib'), { recursive: true })
  mkdirSync(join(dir, CRATE, 'src'), { recursive: true })
  mkdirSync(join(dir, CRATE, 'benches'), { recursive: true })
  writeFileSync(
    join(dir, CRATE, 'src', 'lib.rs'),
    `#[tauri::command]
fn app_version() -> String { String::new() }

fn plain_helper() -> u32 { 0 }

pub fn configure_app() {}
`,
  )
  writeFileSync(join(dir, CRATE, 'benches', 'host.rs'), benchRs(['app_version']))
  writeFileSync(
    join(dir, 'tools', 'native-perf-budget.json'),
    JSON.stringify(budgetJson({})),
  )
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /1 #\[tauri::command\]/)
})

// --- measurement -----------------------------------------------------------

test('measurement: subjects within their ratio caps pass, and the ratios are reported', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
    estimates: { 'ipc/app_version': 650, 'ipc/access_token': 700 },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /ipc\/access_token\s+700ns\s+1\.08x/)
})

test('measurement: a subject over its cap reds — this is the thread::sleep canary in miniature', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
    // 1ms of sleep against a ~650ns invoke floor.
    estimates: { 'ipc/app_version': 650, 'ipc/access_token': 1_000_650 },
  })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.out, /ipc\/access_token: 1539\.46x the normalizer, over its budget of 2x/)
})

test('measurement: the ratio cancels the runner out — a 3x slower machine still passes', () => {
  const subjects = { 'ipc/access_token': { maxRatio: 2 } }
  const commands = ['app_version', 'access_token']
  // Same code, a runner 3x slower across the board. Absolute ns budgets would need 3x of
  // slack to survive this; the ratio does not move at all.
  const slow = project({
    commands,
    subjects,
    estimates: { 'ipc/app_version': 1_950, 'ipc/access_token': 2_100 },
  })
  const r = run(slow)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /1\.08x/)
})

test('measurement: a slow NORMALIZER reds on its absolute ceiling — it cannot hide the rest', () => {
  // The one hole in a ratio scheme: slow the denominator and every ratio below it deflates.
  // access_token is genuinely 10x here, but against an inflated floor it reads as 1.08x and
  // would pass. The normalizer's own raw-nanosecond ceiling is what catches it.
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
    estimates: { 'ipc/app_version': 6_500_000, 'ipc/access_token': 7_000_000 },
  })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.out, /normalizer.*exceeds the absolute ceiling/s)
  assert.match(r.out, /a slow normalizer hides every other regression/)
})

test('measurement: a budgeted subject that produced no estimate reds (a gate that stopped measuring)', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
    estimates: { 'ipc/app_version': 650 }, // access_token bench never ran
  })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.out, /budgeted but criterion produced no estimate/)
})

test('measurement: no criterion output at all self-disables locally (nobody benches every turn)', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /SKIP|no criterion estimate/)
})

test('measurement: ...but FAILS CLOSED in CI, where the lane just ran the bench', () => {
  const dir = project({
    commands: ['app_version', 'access_token'],
    subjects: { 'ipc/access_token': { maxRatio: 2 } },
  })
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  })
  assert.equal(r.status, 1)
})

// --- ramp ------------------------------------------------------------------

test('ramp: a pre-0.1.6 install with no budget gets an adoption NOTE, not a red turn', () => {
  const dir = project({
    commands: ['app_version'],
    budget: null,
    manifest: { baseVersion: '0.1.5', harnessVersion: '0.1.6' },
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /NOTE —/)
  assert.match(r.out, /refresh-seeded/)
})

test('ramp: once graduated to 0.1.6, a missing budget is FATAL — deleting it cannot disarm the floor', () => {
  const dir = project({
    commands: ['app_version'],
    budget: null,
    manifest: { baseVersion: '0.1.6', harnessVersion: '0.1.6' },
  })
  const r = run(dir, ['--closure'])
  assert.equal(r.status, 1)
  assert.match(r.out, /is missing, so every #\[tauri::command\] and the boot path are unmeasured/)
})
