#!/usr/bin/env node
// Gate: diff-coverage (Stop chain, right after `unit`) — every CHANGED source
// file must clear the PER-FILE coverage floors declared in vitest.config.ts.
// The aggregate thresholds (enforced by the unit step itself) cannot see one
// untested module hiding inside a green 70% total; this gate can, and it reads
// the artifact that unit run just wrote (coverage/coverage-final.json, the v8
// provider's istanbul-format map) so no second test run is paid.
//   changed = in CI with a PR base (CI=true + GITHUB_BASE_REF): merge-base diff
//             against the base branch — the whole PR is the diff;
//             otherwise (agent-time local runs): worktree vs HEAD + staged +
//             untracked source files — an agent's brand-new uncommitted feature
//             file is exactly the case that must not slip.
// The floors and the exclusion list are PARSED fail-closed out of
// vitest.config.ts, never duplicated here: that config is write-guard-protected
// and already the single coverage authority, and a regex extract of its two
// named const blocks is the zero-dep option (importing a .ts config from an
// .mjs gate would drag a TS loader into the gate path).
// Empty diff → OK (inherently ramp-safe: a clean upgraded consumer stays
// green without a version ramp). Missing coverage-final.json → FAIL CLOSED
// (the unit step writes it immediately before this gate; absence means the
// chain was reordered or the artifact deleted — never pass).
// SOURCE: docs/harness/README.md (coverage floors; tamper evidence) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { toPosix } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'diff-coverage'
const CONFIG = 'vitest.config.ts'
const COVERAGE_JSON = 'coverage/coverage-final.json'
const METRICS = ['statements', 'branches', 'functions', 'lines']

// ---- fail-closed parse of the two vitest.config.ts data blocks -----------------

export function parsePerFileFloors(configText) {
  const block = configText.match(/PER_FILE_FLOORS\s*=\s*\{([^}]*)\}/)
  if (!block) return null
  const floors = {}
  for (const key of METRICS) {
    const m = block[1].match(new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`))
    if (!m) return null
    floors[key] = Number(m[1])
  }
  return floors
}

export function parseCoverageExcludes(configText) {
  const block = configText.match(/COVERAGE_EXCLUDE\s*=\s*\[([^\]]*)\]/)
  if (!block) return null
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

// ---- pure classifier ------------------------------------------------------------
// Mirrors the vitest coverage surface: include apps/*/src/** + packages/*/src/**
// (the workspace shape is BUILD-SPEC-fixed), code files only, minus test files,
// .d.ts, and the config's COVERAGE_EXCLUDE entries — a changed file vitest does
// not measure must never be demanded coverage for.
const SRC_RE = /^(?:apps|packages)\/[^/]+\/src\//
const CODE_RE = /\.[cm]?[jt]sx?$/
const NON_UNIT_RE = /[.-](?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Conservative mirror of the glob shapes COVERAGE_EXCLUDE actually uses
// (exact relative paths and '**/*.d.ts'-style suffixes): '**' spans path
// segments, '*' stays within one.
const globToRe = (glob) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.split('*').map(escapeRe).join('[^/]*'))
      .join('.*')}$`,
  )

// v8/istanbul coverage keys are ABSOLUTE paths (backslashed on Windows); every
// comparison here is POSIX-relative to the project root. Windows drive letters
// can differ in case between the map and cwd, hence the lowercase retry.
function relativeToRoot(key, root) {
  const k = toPosix(key)
  const r = toPosix(root).replace(/\/+$/, '')
  if (r === '') return k
  if (k.startsWith(`${r}/`)) return k.slice(r.length + 1)
  if (k.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return k.slice(r.length + 1)
  return k
}

// Per-file percentages, derived exactly the way istanbul summarizes a
// FileCoverage (lines = max statement hit per line; pct floored to 2 decimals),
// so an at-floor file agrees with the vitest report the agent just read.
const pct = (covered, total) => (total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100)

function fileMetrics(fc) {
  const stmts = Object.values(fc.s ?? {})
  const fns = Object.values(fc.f ?? {})
  let bTot = 0
  let bCov = 0
  for (const arr of Object.values(fc.b ?? {})) {
    bTot += arr.length
    bCov += arr.filter((n) => n > 0).length
  }
  const lineHit = new Map()
  for (const [id, loc] of Object.entries(fc.statementMap ?? {})) {
    const line = loc?.start?.line
    if (line === undefined) continue
    lineHit.set(line, lineHit.get(line) === true || (fc.s?.[id] ?? 0) > 0)
  }
  return {
    statements: pct(stmts.filter((n) => n > 0).length, stmts.length),
    branches: pct(bCov, bTot),
    functions: pct(fns.filter((n) => n > 0).length, fns.length),
    lines: pct([...lineHit.values()].filter(Boolean).length, lineHit.size),
  }
}

// The pure core (unit-tested without git): which changed files are held to the
// floors, and every violation — absent from the map (no test imported it) or
// below a per-file floor.
export function evaluateDiffCoverage({
  changedFiles,
  coverageJson,
  floors,
  excludes = [],
  root = '',
}) {
  const excludeRes = excludes.map(globToRe)
  const covByRel = new Map()
  for (const [key, entry] of Object.entries(coverageJson ?? {})) {
    covByRel.set(relativeToRoot(key, root), entry)
  }
  const checked = []
  const findings = []
  for (const raw of changedFiles) {
    const file = toPosix(raw)
    if (!SRC_RE.test(file) || !CODE_RE.test(file) || NON_UNIT_RE.test(file)) continue
    if (excludeRes.some((re) => re.test(file))) continue
    checked.push(file)
    const fc = covByRel.get(file)
    if (fc === undefined) {
      findings.push({ file, kind: 'uncovered' })
      continue
    }
    const metrics = fileMetrics(fc)
    for (const metric of METRICS) {
      if (metrics[metric] < floors[metric]) {
        findings.push({
          file,
          kind: 'below-floor',
          metric,
          actual: metrics[metric],
          floor: floors[metric],
        })
      }
    }
  }
  return { findings, checked }
}

// ---- CLI wrapper (git plumbing) — only when executed directly ------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const firstLine = (e) => (e.stderr?.toString() ?? e.message).trim().split('\n')[0]

  const collectChangedFiles = () => {
    if (process.env.CI === 'true' && process.env.GITHUB_BASE_REF) {
      const baseRef = `origin/${process.env.GITHUB_BASE_REF}`
      let mergeBase
      try {
        mergeBase = git(['merge-base', baseRef, 'HEAD']).trim()
      } catch (e) {
        fail(
          GATE,
          `git merge-base ${baseRef} HEAD failed (${firstLine(e)}) — the PR diff cannot be computed. In CI this usually means a shallow checkout: set fetch-depth: 0.`,
        )
      }
      return git(['diff', '--name-only', '--diff-filter=d', mergeBase, 'HEAD'])
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    }
    // Local/agent-time: everything a commit-and-push would carry that HEAD does
    // not — worktree edits, staged-only edits, and untracked files. Deletions
    // are filtered (a removed file has no coverage to demand).
    const out = new Set()
    for (const args of [
      ['diff', '--name-only', '--diff-filter=d', 'HEAD'],
      ['diff', '--name-only', '--diff-filter=d', '--cached'],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      for (const line of git(args).split('\n')) {
        if (line.trim()) out.add(line.trim())
      }
    }
    return [...out]
  }

  if (!existsSync(CONFIG)) {
    fail(
      GATE,
      `${CONFIG} not found — the per-file floors live there; restore it from git (it is write-guard-protected)`,
    )
  }
  const configText = readFileSync(CONFIG, 'utf8')
  const floors = parsePerFileFloors(configText)
  if (floors === null) {
    fail(
      GATE,
      `${CONFIG} carries no parseable PER_FILE_FLOORS block (statements/branches/functions/lines) — this gate fails closed rather than invent numbers; restore vitest.config.ts from git`,
    )
  }
  const excludes = parseCoverageExcludes(configText)
  if (excludes === null) {
    fail(
      GATE,
      `${CONFIG} carries no parseable COVERAGE_EXCLUDE array — this gate fails closed rather than guess which files vitest measures; restore vitest.config.ts from git`,
    )
  }

  if (!existsSync(COVERAGE_JSON)) {
    fail(
      GATE,
      `${COVERAGE_JSON} not found — run the unit step first (\`pnpm exec vitest run --coverage --silent\`). The Stop chain runs it immediately before this gate, so a missing artifact means the chain was reordered or coverage/ was deleted — never a pass.`,
    )
  }
  let coverageJson
  try {
    coverageJson = JSON.parse(readFileSync(COVERAGE_JSON, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${COVERAGE_JSON} is not valid JSON (${e.message}) — re-run \`pnpm exec vitest run --coverage --silent\``,
    )
  }

  let changedFiles
  try {
    changedFiles = collectChangedFiles()
  } catch (e) {
    skipOrFail(
      GATE,
      `cannot enumerate changed files (${firstLine(e)}) — this gate needs a git baseline (git init + an initial commit)`,
    )
  }

  const { findings, checked } = evaluateDiffCoverage({
    changedFiles,
    coverageJson,
    floors,
    excludes,
    root: process.cwd(),
  })

  if (checked.length === 0) {
    ok(GATE, 'no changed source files — the per-file floors have nothing to hold this run')
  }
  failures(
    GATE,
    findings.map((f) =>
      f.kind === 'uncovered'
        ? `${f.file}: absent from ${COVERAGE_JSON} — no unit test imports it (a new module must land with tests)`
        : `${f.file}: ${f.metric} ${String(f.actual)}% is below the per-file floor ${String(f.floor)}%`,
    ),
    `Cover every changed source file to the PER_FILE_FLOORS in vitest.config.ts — reproduce the numbers with \`pnpm exec vitest run --coverage --silent\` (it rewrites ${COVERAGE_JSON}), then re-run this gate.`,
  )
  ok(
    GATE,
    `${String(checked.length)} changed source file(s) clear the per-file floors (statements ${String(floors.statements)} / branches ${String(floors.branches)} / functions ${String(floors.functions)} / lines ${String(floors.lines)})`,
  )
}
