#!/usr/bin/env node
// Stop hook — the unbreakable gate. Runs the full validate gate and exits 2 with errors
// on stderr until green, so the turn cannot end on a red build. Loop-guarded by
// stop_hook_active; bounded by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (settings env).
// SOURCE: docs/harness/README.md (stop-validate-gate)
import { execSync } from 'node:child_process'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.1'

const input = await readHookInput()
const looping = input?.stop_hook_active === true

// Gate steps live in the project's harness config (tools/harness.config.mjs exports
// STOP_HOOK_STEPS: Array<[name, command]>), so projects extend the gate — e.g. add a
// perf-budget check — without editing this hook (which is itself a harness-protected
// file). Resolved relative to this hook: ../../ is the project root.
// If the config cannot be loaded, fall back to the core gate and warn — never skip.
// SOURCE: docs/harness/README.md (stop-validate-gate)
const FALLBACK_STEPS = [['validate', 'pnpm validate']]
let STEPS = FALLBACK_STEPS
try {
  const { STOP_HOOK_STEPS } = await import(
    new URL('../../tools/harness.config.mjs', import.meta.url).href
  )
  if (Array.isArray(STOP_HOOK_STEPS) && STOP_HOOK_STEPS.length > 0) {
    STEPS = STOP_HOOK_STEPS
  } else {
    process.stderr.write(
      'stop-validate-gate: tools/harness.config.mjs did not export a non-empty STOP_HOOK_STEPS array; falling back to `pnpm validate`.\n',
    )
  }
} catch (e) {
  process.stderr.write(
    `stop-validate-gate: could not load tools/harness.config.mjs (${e?.message ?? e}); falling back to \`pnpm validate\`.\n`,
  )
}

const failures = []
for (const [name, cmd] of STEPS) {
  try {
    // 64 MB: vite build output + cargo check diagnostics + docker compose logs can
    // exceed the 1 MB default and make execSync throw ENOBUFS on an otherwise-green
    // step (false FAIL).
    execSync(cmd, { env: process.env, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' })
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    failures.push(`### ${name} FAILED (${cmd})\n${out.slice(-4000)}`)
  }
}

if (failures.length === 0) process.exit(0)

const header = looping
  ? 'The validate gate is STILL red after a prior continuation. Fix the root cause below; do not stop until `pnpm validate` is green.\n\n'
  : 'Done means GREEN GATE. The turn cannot end with a red build. Fix every failure below, then the gate re-runs automatically.\n\n'
process.stderr.write(header + failures.join('\n\n'))
process.exit(2)
