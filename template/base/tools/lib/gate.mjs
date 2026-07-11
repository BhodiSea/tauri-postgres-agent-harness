// Shared gate-script helpers. Doctrine: a gate that cannot run its real check
// SKIPS LOUDLY when the prerequisite is absent locally, and FAILS CLOSED in CI
// (CI=true or HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never look like a pass.
// Every failure path ends with a deterministic `FIX[gate]:` line (exact reproduce
// command + docs pointer) so an agent reading a red Stop block knows the next
// action without spelunking — the feedback loop is part of the product.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { toPosix, walkFiles } from './fs-walk.mjs'

export const inCI = () =>
  process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

// The reproduce command is derived from the running script so it can never drift
// from reality; gates invoked through a wrapper fall back to the whole chain.
function fixHint(gate) {
  const script = process.argv[1]
    ?.split('\\')
    .join('/')
    .replace(/^.*?\/(tools\/)/, '$1')
  const argv = process.argv.slice(2).filter((a) => /^[a-z0-9-]+$/i.test(a))
  const cmd = script?.startsWith('tools/')
    ? ['node', script, ...argv].join(' ')
    : 'node tools/validate.mjs'
  return `FIX[${gate}]: reproduce with \`${cmd}\`; docs: docs/harness/gates-catalog.md ("${gate}")`
}

export function ok(gate, msg) {
  console.log(`${gate}: OK${msg ? ` — ${msg}` : ''}`)
  process.exit(0)
}

export function fail(gate, msg) {
  console.error(`${gate}: FAIL — ${msg}`)
  console.error(fixHint(gate))
  process.exit(1)
}

// Prerequisite missing: loud local skip, hard CI failure.
export function skipOrFail(gate, reason) {
  if (inCI()) {
    console.error(
      `${gate}: FAIL — ${reason} (skips are not allowed in CI: set up the prerequisite or remove the surface)`,
    )
    console.error(fixHint(gate))
    process.exit(1)
  }
  console.log(`${gate}: SKIPPED — ${reason} (this gate FAILS CLOSED in CI)`)
  process.exit(0)
}

export function failures(gate, list, hint) {
  if (list.length === 0) return
  console.error(`${gate}: FAIL (${list.length})`)
  for (const f of list) console.error(`  - ${f}`)
  if (hint) console.error(hint)
  console.error(fixHint(gate))
  process.exit(1)
}

// ---- subprocess capture contract ----------------------------------------------
// One ceiling for every captured gate subprocess: node's 1 MB default
// ENOBUFS-crashes on real monorepo output instead of failing with a named
// gate error.
export const MAX_BUFFER = 64 * 1024 * 1024

// runCmd: execSync under the shared capture contract — utf8, MAX_BUFFER, stdin
// ignored, stdout/stderr piped so a failure still surfaces via e.stdout/e.stderr.
export function runCmd(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
}

// ---- content-addressed stamps (generalized from the rust-check stamp) ---------
// hashInputs: one sha256 over the declared input paths (files or directories,
// recursive, name+bytes, sorted walk so the digest is order-stable). A missing
// path contributes its name — appearing/disappearing invalidates the stamp.
const STAMP_EXCLUDES = new Set(['node_modules', 'target', 'dist', 'gen', 'test-results'])

export function hashInputs(paths) {
  const h = createHash('sha256')
  for (const p of [...paths].sort()) {
    if (!existsSync(p)) {
      h.update(`missing:${p}`)
      continue
    }
    if (statSync(p).isDirectory()) {
      const root = toPosix(p)
      for (const rel of walkFiles(p, { excludeDirs: STAMP_EXCLUDES })) {
        h.update(`${root}/${rel}`)
        h.update(readFileSync(`${p}/${rel}`))
      }
      continue
    }
    h.update(toPosix(p))
    h.update(readFileSync(p))
  }
  return h.digest('hex')
}

// stampGate: if every declared input is byte-identical to the last GREEN run
// (stamp in .harness/<gate>.ok) and we are not in CI, report OK instantly.
// CI always runs the real check — a stamp is a local convenience, never proof.
// Returns recordGreen(); the gate calls it right before its final ok(). Input
// completeness is reviewed data in tools/lib/stamp-inputs.mjs — an undeclared
// input class is a stale-pass bug, so the selftest mutates each class and
// asserts invalidation.
// SOURCE: docs/harness/README.md (rust gates; stamp) [corpus: harness/doctrine]
export function stampGate(gate, inputs) {
  const stampPath = join('.harness', `${gate}.ok`)
  const digest = hashInputs(inputs)
  if (!inCI() && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === digest) {
    ok(gate, `inputs unchanged since last green run (${stampPath}; CI always re-runs)`)
  }
  return function recordGreen() {
    mkdirSync('.harness', { recursive: true })
    writeFileSync(stampPath, digest)
  }
}
