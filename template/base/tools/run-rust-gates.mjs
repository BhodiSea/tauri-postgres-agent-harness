#!/usr/bin/env node
// Gate: rust-fmt / rust-check — the Rust host's format and compile gates, with the
// toolchain asymmetry and a content-hash stamp so the Stop hook stays fast:
//   fmt   — `cargo fmt --check` (seconds; runs whenever cargo exists)
//   check — `cargo check --locked` + tauri-specta bindings drift, gated by a stamp
//           (.harness/rust-check.ok = sha256 over src-tauri sources + Cargo.lock):
//           unchanged Rust → instant OK locally. CI ignores the stamp (fail closed,
//           full run), and clippy -D warnings runs in the CI rust lane, not here.
// SOURCE: docs/harness/README.md (rust gates; stamp) [corpus: harness/doctrine]
import { execSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, inCI, ok, skipOrFail } from './lib/gate.mjs'

const mode = process.argv[2]
const GATE = mode === 'fmt' ? 'rust-fmt' : 'rust-check'
const CRATE = 'apps/desktop/src-tauri'
const MANIFEST = `${CRATE}/Cargo.toml`
const STAMP = '.harness/rust-check.ok'

if (!['fmt', 'check'].includes(mode)) fail(GATE, 'usage: run-rust-gates.mjs <fmt|check>')
if (!existsSync(MANIFEST)) skipOrFail(GATE, `${MANIFEST} not found (no Rust surface yet)`)

const cargoPresent = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
if (!cargoPresent) skipOrFail(GATE, 'cargo not on PATH (install rustup to run Rust gates locally)')

function run(cmd) {
  execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

if (mode === 'fmt') {
  try {
    run(`cargo fmt --manifest-path ${MANIFEST} -- --check`)
  } catch (e) {
    fail(
      GATE,
      `cargo fmt --check failed — run \`cargo fmt --manifest-path ${MANIFEST}\`:\n${(e.stdout?.toString() ?? '').slice(-1500)}`,
    )
  }
  ok(GATE, 'rustfmt clean')
}

// ---- check mode ----
function treeHash() {
  const h = createHash('sha256')
  ;(function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === 'target' || entry === 'gen') continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else {
        h.update(p)
        h.update(readFileSync(p))
      }
    }
  })(CRATE)
  return h.digest('hex')
}

const current = treeHash()
if (!inCI() && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === current) {
  ok(GATE, 'Rust tree unchanged since last green check (stamp hit; CI always runs the real thing)')
}

try {
  run(`cargo check --locked --manifest-path ${MANIFEST}`)
} catch (e) {
  fail(GATE, `cargo check failed:\n${(e.stderr?.toString() ?? e.message).slice(-2500)}`)
}

// tauri-specta bindings drift: the export test regenerates src/ipc/bindings.ts; any
// resulting git diff means committed bindings are stale.
const libSrc = existsSync(`${CRATE}/src/lib.rs`) ? readFileSync(`${CRATE}/src/lib.rs`, 'utf8') : ''
if (/fn\s+export_bindings/.test(libSrc)) {
  let exported = true
  try {
    run(`cargo test --locked --manifest-path ${MANIFEST} export_bindings`)
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

mkdirSync('.harness', { recursive: true })
writeFileSync(STAMP, `${current}\n`)
ok(GATE, 'cargo check clean; specta bindings in sync (stamp refreshed)')
