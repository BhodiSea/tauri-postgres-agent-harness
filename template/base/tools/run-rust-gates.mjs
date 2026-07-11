#!/usr/bin/env node
// Gate: rust-fmt / rust-check — the Rust host's format and compile gates, with the
// toolchain asymmetry and a content-hash stamp so the Stop hook stays fast:
//   fmt   — `cargo fmt --check` (seconds; runs whenever cargo exists)
//   check — `cargo check --locked` + tauri-specta bindings drift, gated by a stamp
//           (.harness/rust-check.ok = sha256 over src-tauri sources + Cargo.lock):
//           unchanged Rust → instant OK locally. CI ignores the stamp (fail closed,
//           full run), and clippy -D warnings runs in the CI rust lane, not here.
// SOURCE: docs/harness/README.md (rust gates; stamp) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fail, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const mode = process.argv[2]
const GATE = mode === 'fmt' ? 'rust-fmt' : 'rust-check'
const CRATE = 'apps/desktop/src-tauri'
const MANIFEST = `${CRATE}/Cargo.toml`

if (!['fmt', 'check'].includes(mode)) fail(GATE, 'usage: run-rust-gates.mjs <fmt|check>')
if (!existsSync(MANIFEST)) skipOrFail(GATE, `${MANIFEST} not found (no Rust surface yet)`)

const cargoPresent = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
if (!cargoPresent) skipOrFail(GATE, 'cargo not on PATH (install rustup to run Rust gates locally)')

if (mode === 'fmt') {
  try {
    runCmd(`cargo fmt --manifest-path ${MANIFEST} -- --check`)
  } catch (e) {
    fail(
      GATE,
      `cargo fmt --check failed — run \`cargo fmt --manifest-path ${MANIFEST}\`:\n${(e.stdout?.toString() ?? '').slice(-1500)}`,
    )
  }
  ok(GATE, 'rustfmt clean')
}

// ---- check mode ----
// Stamped via the shared helper (lib/gate.mjs stampGate). The declared inputs in
// tools/lib/stamp-inputs.mjs include the committed bindings — they are one of
// this gate's ASSERTED outputs: a stamp that ignored them would return
// "unchanged" after someone hand-edits or reverts bindings.ts, silently skipping
// the drift check it exists to run.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

try {
  runCmd(`cargo check --locked --manifest-path ${MANIFEST}`)
} catch (e) {
  fail(GATE, `cargo check failed:\n${(e.stderr?.toString() ?? e.message).slice(-2500)}`)
}

// tauri-specta bindings drift: the export test regenerates src/ipc/bindings.ts; any
// resulting git diff means committed bindings are stale.
const libSrc = existsSync(`${CRATE}/src/lib.rs`) ? readFileSync(`${CRATE}/src/lib.rs`, 'utf8') : ''
if (/fn\s+export_bindings/.test(libSrc)) {
  let exported = true
  try {
    runCmd(`cargo test --locked --manifest-path ${MANIFEST} export_bindings`)
  } catch (e) {
    const errText = e.stderr?.toString() ?? e.message
    // Windows loader quirk, not a bindings problem: the test exe links the full
    // tauri/wry/WebView2 runtime (the commands live in the lib) but has no
    // embedded app manifest, and some Windows loaders then die at load time with
    // STATUS_ENTRYPOINT_NOT_FOUND before any test code runs. Bindings generation
    // is platform-independent and this drift check runs fail-closed on Linux CI
    // for every PR — skip loudly here rather than blocking every Windows dev box.
    if (process.platform === 'win32' && /0xc0000139|STATUS_ENTRYPOINT_NOT_FOUND/.test(errText)) {
      exported = false
      process.stdout.write(
        `${GATE}: SKIP bindings-export sub-check — test exe cannot load on this Windows loader ` +
          '(STATUS_ENTRYPOINT_NOT_FOUND); drift is enforced on Linux CI\n',
      )
    } else {
      fail(GATE, `bindings export test failed:\n${errText.slice(-1500)}`)
    }
  }
  if (exported) {
    const drift = spawnSync('git', ['diff', '--quiet', '--', 'apps/desktop/src/ipc/bindings.ts'])
    if (drift.status !== 0) {
      fail(
        GATE,
        'apps/desktop/src/ipc/bindings.ts drifted from the Rust commands — the specta export rewrote it. Review and commit the regenerated bindings.',
      )
    }
  }
}

recordGreen()
ok(GATE, 'cargo check clean; specta bindings in sync (stamp refreshed)')
