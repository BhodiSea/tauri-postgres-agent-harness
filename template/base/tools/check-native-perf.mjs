#!/usr/bin/env node
// Gate: native-perf — the Rust host's cost, measured on the REAL invoke path.
//
// Until v0.1.6 nothing in this harness observed the native side at all: the perf lane runs
// `vite dev` against a MOCKED IPC bridge, so `#[tauri::command]` host cost, serde round-trip
// and boot were invisible to every check. A command could get 100x slower and all 22 gates,
// the whole e2e suite and the perf lane stayed green.
//
// Two modes, because the two halves have very different costs:
//
//   --closure   Static. Every `#[tauri::command]` in src/lib.rs must have a bench in
//               benches/host.rs AND a budget here. ~10ms, so it runs in the STOP CHAIN:
//               an agent cannot end a turn having added an unmeasured command. This is the
//               half that makes the gate a FLOOR rather than a note about two exemplar
//               commands — without it, the command an agent adds next week is unmeasured
//               host cost, which is exactly how the IPC seam stayed unmeasured until now.
//
//   (default)   Closure + measurement. Reads criterion's estimates and compares each subject
//               against tools/native-perf-budget.json. Needs `cargo bench` to have run
//               (minutes), so it lives in the CI rust lane, never in the turn chain.
//
// Budgets are RATIOS to a normalizer, not nanoseconds — see native-perf-budget.json for the
// measurements behind that choice, including the synthetic-calibration approach that was
// tried first and proved WORSE than not normalizing at all.
// SOURCE: docs/harness/gates-catalog.md (native-perf) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, inCI, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'native-perf'
const CLOSURE_ONLY = process.argv.includes('--closure')

const CRATE = 'apps/desktop/src-tauri'
const LIB = `${CRATE}/src/lib.rs`
const BENCH = `${CRATE}/benches/host.rs`
const CRITERION = `${CRATE}/target/criterion`
const BUDGET = 'tools/native-perf-budget.json'

// No Rust surface (a core-tier install, or a project that dropped the desktop app): nothing
// to measure. Not a skip-shaped hole — there is genuinely no native code to be slow.
if (!existsSync(LIB)) ok(GATE, `${LIB} not found (no Rust host in this project)`)

if (!existsSync(BUDGET)) {
  // The budget names THIS project's command surface, so `update` withholds it (seedOnInitOnly)
  // rather than planting the template's three subjects into a repo with five commands of its
  // own. An upgraded install therefore has no budget, and the floor self-disables with an
  // adoption NOTE instead of ambushing the upgrade with a red turn.
  //
  // rampNote returns TRUE only while the install predates 0.1.6. Once it is on 0.1.6 the
  // budget is mandatory: falling through to `ok()` here would mean an agent could disarm the
  // entire native perf floor by deleting one file.
  const adopt =
    `${BUDGET} absent — the Rust host's cost is unmeasured. Adopting it is a three-part act, because ` +
    'the bench lives in the crate: (1) `update --refresh-seeded tools/native-perf-budget.json ' +
    'apps/desktop/src-tauri/benches/`, (2) add the criterion + tauri["test"] dev-dependencies and the ' +
    '[[bench]] stanza to apps/desktop/src-tauri/Cargo.toml, (3) run the bench and write a subjects[] ' +
    'entry per command from the measured ratio. See docs/harness/gates-catalog.md ("native-perf")'
  if (rampNote(GATE, '0.1.6', adopt)) {
    ok(GATE, `${BUDGET} absent (pre-0.1.6 install; adopt it to arm the native perf floor)`)
  }
  fail(
    GATE,
    `${BUDGET} is missing, so every #[tauri::command] and the boot path are unmeasured. ` +
      'It is write-guard-protected — restore it from git history, or seed one with ' +
      '`npx tauri-postgres-agent-harness update --refresh-seeded tools/native-perf-budget.json`.',
  )
}

const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
const normalizer = budget.normalizer?.subject
if (typeof normalizer !== 'string') {
  fail(GATE, `${BUDGET} declares no normalizer.subject`)
}
const subjects = budget.subjects ?? {}

// ---------------------------------------------------------------------------
// Closure: the command surface, the bench list and the budget must agree.
// ---------------------------------------------------------------------------

// `#[tauri::command]` … optional other attributes … `fn <name>(`. Matching the fn on the
// attribute (rather than scanning for every `fn`) is what keeps a plain helper out of the
// command set — only the IPC surface is a host cost the webview can trigger.
const COMMAND_RE = /#\[tauri::command\][\s\S]{0,400}?\bfn\s+([a-z_][a-z0-9_]*)\s*\(/g
const commands = [...readFileSync(LIB, 'utf8').matchAll(COMMAND_RE)].map((m) => m[1])
if (commands.length === 0) ok(GATE, 'no #[tauri::command] on the IPC surface')

if (!existsSync(BENCH)) {
  fail(
    GATE,
    `${commands.length} #[tauri::command](s) on the IPC surface but ${BENCH} does not exist — ` +
      'every command is an unmeasured host cost. Restore the bench file.',
  )
}

// The bench's own COMMANDS list. criterion names each bench `ipc/<command>`, so this list IS
// the set of subjects the measurement will produce.
const benchSrc = readFileSync(BENCH, 'utf8')
const listed = benchSrc.match(/const\s+COMMANDS\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/)
if (listed === null) {
  fail(
    GATE,
    `${BENCH} has no \`const COMMANDS: &[&str]\` list — the gate cannot see what it benches`,
  )
}
const benched = [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])

const closure = []
for (const command of commands) {
  if (!benched.includes(command)) {
    closure.push(
      `${LIB}: \`${command}\` is a #[tauri::command] with no bench — add "${command}" to COMMANDS in ${BENCH}. ` +
        'An unbenched command is host cost no machine check will ever look at.',
    )
    continue
  }
  const id = `ipc/${command}`
  if (id !== normalizer && subjects[id] === undefined) {
    closure.push(
      `${BUDGET}: \`${id}\` is benched but has no budget — add a subjects["${id}"] entry with a maxRatio. ` +
        'Run the bench, take the measured ratio, and give it headroom.',
    )
  }
}
for (const name of benched) {
  if (!commands.includes(name)) {
    closure.push(
      `${BENCH}: COMMANDS lists "${name}", which is not a #[tauri::command] in ${LIB} — stale entry (the bench would panic).`,
    )
  }
}
failures(GATE, closure, `every #[tauri::command] must be benched and budgeted (${BUDGET})`)

if (CLOSURE_ONLY) {
  ok(
    GATE,
    `closure OK — ${commands.length} #[tauri::command](s), all benched and budgeted ` +
      `(measurement runs in the CI rust lane: cargo bench + \`node tools/check-native-perf.mjs\`)`,
  )
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

/** criterion writes target/criterion/<group>/<bench>/new/estimates.json; mean is in ns. */
function meanNanos(id) {
  const path = `${CRITERION}/${id}/new/estimates.json`
  if (!existsSync(path)) return null
  const mean = JSON.parse(readFileSync(path, 'utf8')).mean?.point_estimate
  return typeof mean === 'number' && Number.isFinite(mean) && mean > 0 ? mean : null
}

const base = meanNanos(normalizer)
if (base === null) {
  // Locally this is the normal state — nobody runs `cargo bench` on every turn. In CI it is
  // fail-closed: the lane ran the bench, so a missing estimate means the bench did not run.
  skipOrFail(
    GATE,
    `no criterion estimate for the normalizer \`${normalizer}\` under ${CRITERION}/ — ` +
      `run \`cargo bench --manifest-path ${CRATE}/Cargo.toml --bench host\` first ` +
      '(the CI rust lane does; the turn chain runs --closure only, since a bench takes minutes)',
  )
}

const rows = []
const bad = []

// The normalizer's own absolute ceiling. It cannot be normalized against itself, so this is
// the one raw-nanosecond check — deliberately loose, because it is the only one exposed to
// the full run-to-run spread of a shared runner. Its job is to catch a regression that slows
// the NORMALIZER down, which would otherwise deflate every ratio below it and hide the rest.
const maxNanos = budget.normalizer?.maxNanos
if (typeof maxNanos === 'number' && base > maxNanos) {
  bad.push(
    `${normalizer} (normalizer): ${base.toFixed(0)}ns exceeds the absolute ceiling of ${String(maxNanos)}ns. ` +
      'Every other budget is a ratio to this, so a slow normalizer hides every other regression. ' +
      'Either the invoke path itself regressed, or work landed in a command that should be doing none.',
  )
}
rows.push(
  `  ${normalizer.padEnd(24)} ${base.toFixed(0).padStart(9)}ns  (normalizer, ceiling ${String(maxNanos ?? '—')}ns)`,
)

for (const [id, spec] of Object.entries(subjects)) {
  const mean = meanNanos(id)
  if (mean === null) {
    bad.push(
      `${id}: budgeted but criterion produced no estimate — the bench did not run. ` +
        'A budgeted subject that silently stops being measured is a gate that has quietly turned itself off.',
    )
    continue
  }
  const ratio = mean / base
  const cap = spec.maxRatio
  const over = typeof cap === 'number' && ratio > cap
  rows.push(
    `  ${id.padEnd(24)} ${mean.toFixed(0).padStart(9)}ns  ${ratio.toFixed(2).padStart(6)}x  ` +
      `(cap ${String(cap)}x)${over ? '  <-- OVER' : ''}`,
  )
  if (over) {
    bad.push(
      `${id}: ${ratio.toFixed(2)}x the normalizer, over its budget of ${String(cap)}x ` +
        `(${mean.toFixed(0)}ns vs ${base.toFixed(0)}ns). Expected ${spec.observed ?? 'see the budget file'}. ` +
        'Ratios cancel most of the runner out, so this is a real regression, not a slow machine — ' +
        `find the added work, or raise the cap in ${BUDGET} in a reviewed commit if it is deliberate.`,
    )
  }
}

process.stdout.write(`${GATE}: measured (ratios to \`${normalizer}\`)\n${rows.join('\n')}\n`)
failures(GATE, bad, `native host budgets (${BUDGET})`)

ok(
  GATE,
  `${String(Object.keys(subjects).length + 1)} bench subject(s) within budget ` +
    `(normalizer ${normalizer} = ${base.toFixed(0)}ns${inCI() ? '; CI: fail-closed' : ''})`,
)
