#!/usr/bin/env node
// Gate: docs-sync — the agent-facing documentation can never lie about the gate.
//   1. CLAUDE.md stays a pure `@AGENTS.md` include (one canonical memory file).
//   2. The AGENTS.md gate list ("The N gates, in order: ...") matches
//      VALIDATE_STEPS exactly — names, order, and count — so an agent reading
//      the docs and an agent reading the config act on the same chain.
//   3. Every `pnpm <script>` command AGENTS.md tells agents to run exists in
//      the root package.json scripts.
// This makes the release-time "update the docs" sweep MECHANICAL: change the
// chain and this gate names exactly the lines to fix.
// SOURCE: docs/harness/README.md (docs-sync gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { VALIDATE_STEPS } from './harness.config.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'docs-sync'
const errs = []

if (!existsSync('AGENTS.md')) skipOrFail(GATE, 'AGENTS.md not found (no docs surface yet)')

// 1. CLAUDE.md purity.
if (existsSync('CLAUDE.md')) {
  if (readFileSync('CLAUDE.md', 'utf8').trim() !== '@AGENTS.md') {
    errs.push('CLAUDE.md is not a pure `@AGENTS.md` include — content belongs in AGENTS.md')
  }
} else {
  errs.push('CLAUDE.md missing — it must exist as a pure `@AGENTS.md` include')
}

const agents = readFileSync('AGENTS.md', 'utf8')
const stepNames = VALIDATE_STEPS.map(([name]) => name)

// 2. Gate list lockstep. The docs sentence is data: "The N gates, in order:
//    `a`, `b`, ..." — parse the backticked names between the marker and the
//    closing parenthetical/period.
const listMatch = agents.match(/The (\d+) gates, in order:([\s\S]*?)(?:\(|\.\s*$|\.\n)/m)
if (!listMatch) {
  errs.push('AGENTS.md is missing the "The N gates, in order: ..." sentence — document the chain')
} else {
  const documentedCount = Number(listMatch[1])
  const documented = [...listMatch[2].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
  if (documentedCount !== stepNames.length) {
    errs.push(
      `AGENTS.md says "The ${String(documentedCount)} gates" but VALIDATE_STEPS has ${String(stepNames.length)} — update the count`,
    )
  }
  if (documented.join(',') !== stepNames.join(',')) {
    errs.push(
      `AGENTS.md gate list drifted from VALIDATE_STEPS.\n    documented: ${documented.join(', ')}\n    actual:     ${stepNames.join(', ')}`,
    )
  }
  const chainCount = agents.match(/the (\d+)-step chain/)
  if (chainCount && Number(chainCount[1]) !== stepNames.length) {
    errs.push(
      `AGENTS.md says "the ${chainCount[1]}-step chain" but VALIDATE_STEPS has ${String(stepNames.length)} steps`,
    )
  }
}

// 3. Advertised pnpm scripts exist. Only bare `pnpm <script>` invocations are
//    script names; exec/dlx/install/add/--filter forms are pnpm-native.
let scripts = {}
try {
  scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
} catch (e) {
  fail(GATE, `package.json unreadable (${e.message})`)
}
const PNPM_NATIVE = new Set(['exec', 'dlx', 'install', 'add', 'remove', 'run', 'update'])
const advertised = new Set(
  [...agents.matchAll(/`pnpm ([a-z0-9:_-]+)`?/g)]
    .map((m) => m[1])
    .filter((cmd) => !PNPM_NATIVE.has(cmd)),
)
for (const cmd of advertised) {
  if (!(cmd in scripts) && !(`harness:${cmd}` in scripts)) {
    errs.push(`AGENTS.md advertises \`pnpm ${cmd}\` but package.json has no such script`)
  }
}

failures(GATE, errs)
ok(
  GATE,
  `AGENTS.md gate list in lockstep with the ${String(stepNames.length)}-step chain; CLAUDE.md pure; ${String(advertised.size)} advertised commands all exist`,
)
