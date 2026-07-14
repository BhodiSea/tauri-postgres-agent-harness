#!/usr/bin/env node
// Gate: perf-budget — default-on since v0.1.3 (promoted from the gate-perf-budget
// module).
//
// Median-of-N render budget over REAL feature subjects: N runs after warmup measure
// `renderToString` wall time and assert the MEDIAN against tools/perf-budget.json
// (write-guard-protected — raising the budget is a reviewed human decision).
// Median over mean: runners spike; a single GC pause must not flake the gate, but
// a real regression shifts the median. Belt and braces, the gate RE-MEASURES ONCE
// before failing — a red requires two independent over-budget medians, so
// scheduler noise cannot fail a turn while a genuine 10x regression still cannot
// pass.
//
// THREE budget shapes, selected by the JSON content (content-conditional — the
// budget file is SEEDED, so `update` never rewrites it and a gate refresh can
// never flip an existing install's shape behind its back):
//   • subjects: [{ subject, cells, medianBudgetMs, expect? }] (the shipped 0.1.5
//     form) — each entry is measured sequentially through the tsx CLI path below
//     under the shared top-level `runs` (one measurement protocol per budget:
//     medians stay comparable across subjects, and the re-measure-once discipline
//     is calibrated to N — per-subject run counts would fracture both for zero
//     demonstrated need). This shape also arms the DENSE-FEATURE CLOSURE scan:
//     every apps/desktop/src/features/* dir that imports the matrix hooks
//     (useVirtualWindow / useRovingGrid) must ship a perfSubject.ts declared in
//     subjects[], every declared file must exist, and every features/*/
//     perfSubject.ts must be declared — a dense screen nobody measures is the
//     green-but-bad path this gate exists to close. `exempt: [{ dir, reason }]`
//     is the reviewed escape (the rls-exempt pattern; malformed entries FAIL, never
//     fail open). Declaring BOTH `subject` and `subjects` is an ambiguity FAIL.
//   • subject: "<path>" (legacy 0.1.4 budgets) — exactly the single-subject
//     behavior that shipped in 0.1.4, plus a NOTE naming the subjects[] form and
//     the deliberate adoption command (`update --refresh-seeded
//     tools/perf-budget.json`).
//   • subject ABSENT (legacy pre-0.1.4 budgets) — the in-process synthetic
//     rows×cols fixture below, byte-for-byte as it shipped in 0.1.3.
//
// One measurement = one CLI spawn: `pnpm --filter desktop exec tsx` on
// tools/lib/perf-subject-cli.mjs renders the subject's real component graph.
// A missing subject file, unresolvable tsx, spawn failure, malformed CLI output,
// or a vacuous render (the per-subject `expect` marker — default role="gridcell"
// — absent from the HTML) is a hard FAIL with a named reason — NEVER a silent
// fallback to the synthetic path.
//
// This is deliberately a RELATIVE canary, not a UX metric: it catches "someone
// made cell rendering 5× slower" in the validate chain, cheaply, with no browser.
// Budgets ship ~10× above a fresh-scaffold median so real features fit; the
// ABSOLUTE UX numbers (TTI, arrow-key latency, long tasks) live in the CI-only
// interaction-latency lane — e2e/interaction-latency.spec.ts under
// HARNESS_PERF_LANE=1, budgets in tools/interaction-budget.json — which runs as
// the blocking quality-gate perf-lane job, never inside this chain.
// SOURCE: docs/harness/gates-catalog.md (perf-budget gate) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, MAX_BUFFER, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { blankComments, lineOf, skipBalanced } from './lib/source-text.mjs'

const GATE = 'perf-budget'
const BUDGET_PATH = 'tools/perf-budget.json'
const DESKTOP_SRC = 'apps/desktop/src'
const FEATURES_DIR = 'apps/desktop/src/features'
const WORKED_SUBJECT = 'apps/desktop/src/features/matrix/perfSubject.ts'
const DEFAULT_EXPECT = 'role="gridcell"'

if (!existsSync('apps/desktop/package.json'))
  skipOrFail(GATE, 'apps/desktop not found (no desktop surface yet)')
if (!existsSync(BUDGET_PATH)) {
  fail(GATE, `${BUDGET_PATH} missing — the render budget must exist as reviewable data; restore it`)
}
let budget
try {
  budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
} catch (e) {
  fail(GATE, `${BUDGET_PATH} is not valid JSON (${e.message}) — the budget must be reviewable data`)
}

// ---- leak discipline (G15) ------------------------------------------------------
// Runs for EVERY budget shape, before any measurement: a leak is a performance defect
// whatever vintage the budget file is.
//
// Nothing in the harness observed memory before 0.1.6 — not one check, at any layer. An
// effect that subscribes and never unsubscribes is the canonical React leak: every mount
// adds a listener, every unmount leaves it, and the cost is invisible in a render
// benchmark (which mounts once) and invisible in the e2e suite (which never navigates
// back). It shows up only in a long session, as the thing users call "it gets slow after
// a while".
//
// This is the AGENT-TIME half — a structural scan, deterministic, no browser. The CI half
// (e2e/memory.spec.ts, perf lane) actually samples the heap across a navigate-and-back
// loop and catches leaks whose shape this scan cannot see.
//
// The rule: an effect that REGISTERS something must TEAR IT DOWN in the cleanup it
// returns. Pairs are matched by name, and the teardown must appear inside the returned
// cleanup — not merely somewhere in the effect, or `return () => {}` would satisfy it.
const LEAK_PAIRS = [
  {
    register: /\.addEventListener\s*\(/,
    teardown: /\.removeEventListener\s*\(/,
    what: 'addEventListener',
    fix: 'removeEventListener',
  },
  {
    register: /\bsetInterval\s*\(/,
    teardown: /\bclearInterval\s*\(/,
    what: 'setInterval',
    fix: 'clearInterval',
  },
  {
    register: /\brequestAnimationFrame\s*\(/,
    teardown: /\bcancelAnimationFrame\s*\(/,
    what: 'requestAnimationFrame',
    fix: 'cancelAnimationFrame',
  },
  {
    register: /\bnew\s+(?:Mutation|Resize|Intersection|Performance)Observer\b/,
    teardown: /\.disconnect\s*\(/,
    what: 'an Observer',
    fix: '.disconnect()',
  },
  {
    register: /\.subscribe\s*\(/,
    teardown: /\.unsubscribe\s*\(|\.close\s*\(|\breturn\s+\w+\s*$/,
    what: '.subscribe(',
    fix: ".unsubscribe() (or return the subscription's own teardown)",
  },
]

// The cleanup is whatever the effect RETURNS. Find the first top-level `return` inside the
// effect body and take everything from there to the body's end: a returned arrow, a
// returned function expression, or a returned identifier (a teardown handed back directly,
// e.g. `return unsubscribe`) all fall inside that slice.
function cleanupSliceOf(body) {
  const at = body.search(/\breturn\b/)
  return at === -1 ? null : body.slice(at)
}

/** The `useEffect(() => { … })` bodies in a source file, comments already blanked. */
function effectBodies(text) {
  const bodies = []
  for (const m of text.matchAll(/\buse(?:Effect|LayoutEffect)\s*\(/g)) {
    const open = text.indexOf('(', m.index)
    const callEnd = skipBalanced(text, open)
    const brace = text.indexOf('{', open)
    if (brace === -1 || brace > callEnd) continue // concise-body effect: nothing to register
    bodies.push({ body: text.slice(brace, skipBalanced(text, brace)), index: m.index })
  }
  return bodies
}

/** The pairs this effect body REGISTERS but never tears down in the cleanup it RETURNS. */
function unpairedIn(body) {
  const cleanup = cleanupSliceOf(body)
  return LEAK_PAIRS.filter(
    (pair) => pair.register.test(body) && !(cleanup !== null && pair.teardown.test(cleanup)),
  )
}

function leaksInFile(path) {
  // Comments blanked FIRST: a `removeEventListener` named only in a comment must never
  // satisfy this check (the styleguide gate shipped exactly that fail-open once).
  const text = blankComments(readFileSync(path, 'utf8'))
  const errs = []
  for (const { body, index } of effectBodies(text)) {
    for (const pair of unpairedIn(body)) {
      errs.push(
        `${path}:${lineOf(text, index)}: this effect registers ${pair.what} but its cleanup never calls ${pair.fix} — every mount adds one and every unmount leaves it behind, so the listener set grows without bound for as long as the app runs. A render benchmark mounts once and an e2e spec never navigates back, so NOTHING else in the chain can see this. FIX: return a cleanup function from the effect that calls ${pair.fix}; or, if this registration genuinely outlives the component by design, add a reviewed {"file": "${path}", "reason": …} entry to ${BUDGET_PATH} effectCleanupAllow[]`,
      )
    }
  }
  return errs
}

function scanEffectLeaks(allowFiles) {
  if (!existsSync(DESKTOP_SRC)) return []
  const files = walkFiles(DESKTOP_SRC, {
    excludeDirs: new Set(['node_modules']),
    filter: (rel) => /\.tsx?$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel),
  })
  const errs = []
  for (const rel of files) {
    const path = `${DESKTOP_SRC}/${rel}`
    if (!allowFiles.has(path)) errs.push(...leaksInFile(path))
  }
  return errs
}

// Reviewed escape (the rls-exempt pattern): a malformed or stale entry FAILS, never opens.
const leakAllow = new Set()
if (budget.effectCleanupAllow !== undefined) {
  if (!Array.isArray(budget.effectCleanupAllow)) {
    fail(
      GATE,
      `${BUDGET_PATH} "effectCleanupAllow" must be an ARRAY of { "file": path, "reason": non-empty string } entries — got ${JSON.stringify(budget.effectCleanupAllow)}`,
    )
  }
  for (const entry of budget.effectCleanupAllow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.file === 'string' &&
      entry.file.trim() !== '' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${BUDGET_PATH}: every effectCleanupAllow entry must be { "file": repo-relative path, "reason": non-empty string } — got ${JSON.stringify(entry)}`,
      )
    }
    if (!existsSync(entry.file)) {
      fail(
        GATE,
        `${BUDGET_PATH} effectCleanupAllow names "${entry.file}", which does not exist — stale exemption; remove it (a stale escape is a loaded gun aimed at the next file to take that path)`,
      )
    }
    leakAllow.add(entry.file)
  }
}

// Ramped to 0.1.6: an upgraded consumer's existing effects were never held to this bar, so
// the first pass NOTEs rather than reds. Turn-fatal on a fresh 0.1.6 install.
const leakErrs = scanEffectLeaks(leakAllow)
if (
  leakErrs.length > 0 &&
  rampNote(GATE, '0.1.6', `${leakErrs.length} effect-cleanup finding(s)`)
) {
  for (const e of leakErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
} else {
  failures(
    GATE,
    leakErrs,
    '  Leak discipline: an effect that registers a listener/timer/observer/subscription must tear it down in the cleanup it returns (see docs/harness/gates-catalog.md "perf-budget").',
  )
}

// ---- real-subject measurement (shared by the subjects[] and legacy-subject paths)
const cliAbs = fileURLToPath(new URL('./lib/perf-subject-cli.mjs', import.meta.url))

// One measurement = one CLI spawn. tsx resolves react/react-dom from the desktop
// workspace and transpiles the TS import graph; shell:true lets Windows run the
// `pnpm`/`tsx` .cmd shims. Any non-zero exit or unusable stdout is a FAIL — the
// gate never quietly substitutes the synthetic fixture. `expect` (the per-subject
// anti-vacuity marker) travels via the PERF_SUBJECT_EXPECT environment variable,
// not argv: markers like role="gridcell" would be mangled by shell:true quoting.
// The legacy single-subject path passes undefined — the spawn env stays exactly
// as it shipped in 0.1.4 and the CLI applies its own gridcell default.
function measureViaSubject(subjectRel, cells, runs, expect, markerScales) {
  const subjectAbs = resolve(process.cwd(), subjectRel)
  // markerScales (G30): the CLI asserts the marker count SCALES with `cells`, not merely
  // that it is present — a one-row subject used to "pass" the budget in ~1 ms. A subject
  // whose marker is a per-render container rather than per-cell opts out with
  // `markerScales: false`, and takes the weaker presence-only guarantee.
  const env = { ...process.env }
  if (expect !== undefined) env.PERF_SUBJECT_EXPECT = expect
  if (markerScales === false) env.PERF_SUBJECT_MARKER_SCALES = '0'
  const res = spawnSync(
    'pnpm',
    ['--filter', 'desktop', 'exec', 'tsx', cliAbs, subjectAbs, String(cells), String(runs)],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true,
      maxBuffer: MAX_BUFFER,
      env,
    },
  )
  if (res.error) {
    fail(
      GATE,
      `could not spawn the perf subject via \`pnpm --filter desktop exec tsx\` (${res.error.message}) — run pnpm install / fix tsx; the gate never falls back to a synthetic measurement`,
    )
  }
  if (res.status !== 0) {
    const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-4).join(' | ')
    fail(
      GATE,
      `the real perf subject failed to measure (exit ${res.status}) via \`pnpm --filter desktop exec tsx ${subjectRel}\`: ${detail} — fix the subject or the toolchain; the gate never falls back to a synthetic measurement`,
    )
  }
  let parsed
  for (const line of (res.stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      parsed = JSON.parse(t)
    } catch {
      /* not the samples line — keep scanning */
    }
  }
  const okShape =
    parsed !== undefined &&
    Array.isArray(parsed.samples) &&
    parsed.samples.length === runs &&
    parsed.samples.every((s) => typeof s === 'number' && Number.isFinite(s))
  if (!okShape) {
    fail(
      GATE,
      `the perf subject CLI did not emit a valid {"samples":[…]} line of ${runs} numbers (stdout: ${JSON.stringify((res.stdout ?? '').slice(0, 200))}) — measurement is unusable`,
    )
  }
  const sorted = [...parsed.samples].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], samples: parsed.samples }
}

// Median-of-runs with the re-measure-once discipline, parameterized by subject
// entry; fails the gate on two independent over-budget medians, otherwise
// returns the human-readable detail line.
/** @param {{ subject: string, cells: number, runs: number, medianBudgetMs: number, expect?: string, markerScales?: boolean }} entry */
function measureWithRetry({ subject, cells, runs, medianBudgetMs, expect, markerScales }) {
  let { median, samples } = measureViaSubject(subject, cells, runs, expect, markerScales)
  let retried = false
  if (median > medianBudgetMs) {
    // One full re-measure before failing: two independent over-budget medians
    // cannot both be scheduler noise.
    retried = true
    ;({ median, samples } = measureViaSubject(subject, cells, runs, expect, markerScales))
  }
  const detail = `subject ${subject}, ${cells} cells, ${runs} runs${retried ? ' (re-measured once)' : ''}: median ${median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${samples.map((s) => s.toFixed(0)).join('/')}ms)`
  if (median > medianBudgetMs) {
    fail(
      GATE,
      `${detail} — render cost regressed past the budget twice in a row. Find the regression (or, after a DELIBERATE change to the subject, re-baseline ${BUDGET_PATH} in a reviewed commit).`,
    )
  }
  return detail
}

// ---- shape dispatch -------------------------------------------------------------
// Key PRESENCE (not just truthiness) decides the shape, so a malformed value gets
// the right contract error instead of silently landing in another path.
const hasSubjects = budget.subjects !== undefined
if (hasSubjects && budget.subject !== undefined) {
  fail(
    GATE,
    `${BUDGET_PATH} declares BOTH "subject" and "subjects" — ambiguous: the gate cannot know which contract to enforce. Keep "subjects" (the current form) and delete the legacy "subject" key.`,
  )
}

// ---- subjects[] path: plural real subjects + dense-feature closure --------------
if (hasSubjects) {
  const { runs } = budget
  if (typeof runs !== 'number' || runs <= 0) {
    fail(
      GATE,
      `${BUDGET_PATH} must carry a positive number for runs (shared by every subjects[] entry — one measurement protocol per budget)`,
    )
  }
  const ENTRY_SHAPE =
    '{ "subject": non-empty string, "cells": positive number, "medianBudgetMs": positive number, "expect"?: non-empty string }'
  if (!Array.isArray(budget.subjects) || budget.subjects.length === 0) {
    fail(
      GATE,
      `${BUDGET_PATH} "subjects" must be a NON-EMPTY array of ${ENTRY_SHAPE} — an empty measurement list is a vacuous pass (worked pattern: ${WORKED_SUBJECT})`,
    )
  }
  for (const entry of budget.subjects) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.subject === 'string' &&
      entry.subject.trim() !== '' &&
      typeof entry.cells === 'number' &&
      entry.cells > 0 &&
      typeof entry.medianBudgetMs === 'number' &&
      entry.medianBudgetMs > 0 &&
      (entry.expect === undefined ||
        (typeof entry.expect === 'string' && entry.expect.trim() !== ''))
    if (!okShape) {
      fail(
        GATE,
        `${BUDGET_PATH}: every subjects[] entry must be ${ENTRY_SHAPE} — got ${JSON.stringify(entry)}`,
      )
    }
  }
  const declared = new Set()
  for (const entry of budget.subjects) {
    if (declared.has(entry.subject)) {
      fail(
        GATE,
        `${BUDGET_PATH} subjects[] declares "${entry.subject}" twice — one budget per subject; remove the duplicate`,
      )
    }
    declared.add(entry.subject)
  }

  // Exemptions — the ONE escape hatch for the closure rule below, so its parse
  // fails LOUD, never open (the rls-exempt pattern). `dir` is the bare feature
  // directory NAME under apps/desktop/src/features/, not a path.
  const exemptDirs = new Set()
  if (budget.exempt !== undefined) {
    if (!Array.isArray(budget.exempt)) {
      fail(
        GATE,
        `${BUDGET_PATH} "exempt" must be an ARRAY of { "dir": feature dir name, "reason": non-empty string } entries — got ${JSON.stringify(budget.exempt)}`,
      )
    }
    for (const entry of budget.exempt) {
      const okShape =
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.dir === 'string' &&
        entry.dir.trim() !== '' &&
        !entry.dir.includes('/') &&
        typeof entry.reason === 'string' &&
        entry.reason.trim().length > 0
      if (!okShape) {
        fail(
          GATE,
          `${BUDGET_PATH}: every exemption must be { "dir": feature dir NAME under ${FEATURES_DIR}/ (no slashes), "reason": non-empty string } — got ${JSON.stringify(entry)}`,
        )
      }
      exemptDirs.add(entry.dir)
    }
  }

  // ---- dense-feature closure ------------------------------------------------
  // Detection is TEXTUAL, pinned to `from '<...>'` module specifiers whose
  // basename is one of the matrix hooks — tolerant of relative-path variants
  // (./useVirtualWindow, ../matrix/useRovingGrid, an alias ending in
  // /useVirtualWindow) and optional extensions, and it covers both import and
  // re-export statements. Limits, honestly: no AST — a commented-out import or a
  // string literal containing such a specifier still counts as dense
  // (over-detection reds with `exempt` as the reviewed escape; it can never
  // fail-open green), and a feature reaching the hooks only through a barrel
  // re-export in ANOTHER dir is not detected — the inverse closure (every
  // features/*/perfSubject.ts must be declared) still covers such features once
  // they ship a subject.
  const DENSE_IMPORT =
    /\bfrom\s*(['"])(?:[^'"]*\/)?(?:useVirtualWindow|useRovingGrid)(?:\.[cm]?[tj]sx?)?\1/

  // G13 — density is a SHAPE, not two import names. The v0.1.5 closure keyed entirely on
  // `useVirtualWindow`/`useRovingGrid`, so a dense screen that hand-rolled its
  // virtualization, painted to a canvas, or simply rendered a big grid was never measured
  // by anything. These STRUCTURAL signals catch the shape instead of the spelling:
  //   • aria-rowcount — the APG marker a grid uses to declare a row count LARGER than the
  //     DOM it renders. Nothing else has a reason to say it: it IS the virtualization tell.
  //   • role="grid"   — a 2-D data surface.
  //   • <canvas       — an imperative paint surface, dense by construction.
  // Extensible as reviewable data: `densitySignals: ["regex-source", …]` in perf-budget.json.
  // Over-detection reds with `exempt[]` as the reviewed escape; it can never fail open.
  const DEFAULT_DENSITY_SIGNALS = [
    String.raw`aria-rowcount`,
    String.raw`role=["']grid["']`,
    String.raw`<canvas\b`,
  ]
  const configured = budget.densitySignals
  if (configured !== undefined && !Array.isArray(configured)) {
    fail(
      GATE,
      `${BUDGET_PATH} densitySignals must be an ARRAY of regex-source strings — got ${JSON.stringify(configured)}`,
    )
  }
  const signalSources = (configured ?? DEFAULT_DENSITY_SIGNALS).map((s) => {
    if (typeof s !== 'string' || s === '') {
      fail(GATE, `${BUDGET_PATH} densitySignals entries must be non-empty regex-source strings`)
    }
    return s
  })
  const DENSITY_SIGNALS = signalSources.map((s) => new RegExp(s))
  // A consumer without a features/ tree (e.g. a 0.1.3-vintage install that
  // adopted subjects[] by hand) has nothing to scan: the closure below no-ops
  // and only the declared-file existence check applies.
  const featureDirs = existsSync(FEATURES_DIR)
    ? readdirSync(FEATURES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : []
  const errs = []
  // v0.1.6 structural-density findings, held separately so they can be ramped: an upgraded
  // consumer's existing grid/canvas screen must not be ambushed by newly-widened detection.
  const shapeErrs = []
  for (const entry of budget.subjects) {
    if (!existsSync(resolve(process.cwd(), entry.subject))) {
      errs.push(
        `subjects[] declares "${entry.subject}" but the file does not exist — restore it or remove the entry; harness exemplars can be pulled with \`npx tauri-postgres-agent-harness update --refresh-seeded <path>\` (a pre-0.1.4 install must pull apps/desktop/src/features/matrix/ before adopting the matrix subject)`,
      )
    }
  }
  for (const dirName of featureDirs) {
    if (exemptDirs.has(dirName)) continue // reviewed escape — skips both closure directions
    const dirRel = `${FEATURES_DIR}/${dirName}`
    const files = walkFiles(dirRel, {
      excludeDirs: new Set(['node_modules']),
      filter: (rel) => /\.tsx?$/.test(rel),
    })
    const sources = files.map((rel) => readFileSync(`${dirRel}/${rel}`, 'utf8'))
    // The v0.1.5 signal (hook import) stays turn-fatal. The v0.1.6 structural signals are
    // RAMPED — broadening detection would otherwise ambush an upgraded consumer whose
    // existing grid/canvas screen was never held to this bar.
    const denseByHook = sources.some((src) => DENSE_IMPORT.test(src))
    const matchedSignals = DENSITY_SIGNALS.filter((re) => sources.some((src) => re.test(src)))
    const denseByShape = matchedSignals.length > 0
    const subjectRel = `${dirRel}/perfSubject.ts`
    const hasSubjectFile = existsSync(subjectRel)
    if (denseByHook && !hasSubjectFile) {
      errs.push(
        `${dirRel}/ imports useVirtualWindow/useRovingGrid (data-dense by doctrine) but ships NO perfSubject.ts — a dense screen nobody measures is a silent regression farm. FIX: create ${subjectRel} exporting renderSubject(cells): string that renderToString's the feature's dense component (worked pattern: ${WORKED_SUBJECT}), declare it in ${BUDGET_PATH} subjects[] with its cells + medianBudgetMs, or exempt "${dirName}" with a reviewed reason in ${BUDGET_PATH} exempt[]`,
      )
    } else if (denseByShape && !hasSubjectFile) {
      shapeErrs.push(
        `${dirRel}/ is data-dense by SHAPE (${matchedSignals.map((re) => re.source).join(', ')}) but ships NO perfSubject.ts — density is a shape, not an import name: a screen that hand-rolls its virtualization, paints a canvas, or renders a grid is exactly as capable of regressing as one that imports the matrix hooks. FIX: create ${subjectRel} (worked pattern: ${WORKED_SUBJECT}) and declare it in ${BUDGET_PATH} subjects[], or exempt "${dirName}" with a reviewed reason in ${BUDGET_PATH} exempt[]`,
      )
    }
    if (hasSubjectFile && !declared.has(subjectRel)) {
      errs.push(
        `${subjectRel} exists but is not declared in ${BUDGET_PATH} subjects[] — an unmeasured subject is decoration; add { "subject": "${subjectRel}", "cells": …, "medianBudgetMs": … } (or exempt "${dirName}" with a reviewed reason)`,
      )
    }
  }
  for (const dirName of [...exemptDirs].sort()) {
    if (!featureDirs.includes(dirName)) {
      errs.push(
        `${BUDGET_PATH} exempts feature dir "${dirName}" but ${FEATURES_DIR}/${dirName}/ does not exist — stale exemption; remove it`,
      )
    }
  }
  // Ramp the SHAPE findings only (the hook signal keeps its v0.1.5 turn-fatal contract).
  if (
    shapeErrs.length > 0 &&
    rampNote(GATE, '0.1.6', `${shapeErrs.length} structural-density finding(s)`)
  ) {
    for (const e of shapeErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  } else {
    errs.push(...shapeErrs)
  }

  failures(
    GATE,
    errs,
    `  Dense-feature closure: every ${FEATURES_DIR}/* dir that is data-dense — by importing the matrix hooks, or by SHAPE (aria-rowcount / role="grid" / <canvas>) — ships a measured perfSubject.ts (see docs/harness/gates-catalog.md "perf-budget").`,
  )

  // Closure holds — measure every declared subject sequentially (never in
  // parallel: these are wall-clock medians and CPU contention would flake them).
  const details = budget.subjects.map((entry) =>
    measureWithRetry({
      subject: entry.subject,
      cells: entry.cells,
      runs,
      medianBudgetMs: entry.medianBudgetMs,
      expect: entry.expect ?? DEFAULT_EXPECT,
    }),
  )
  ok(GATE, details.join('; '))
}

// ---- legacy shapes (pre-0.1.5 budgets): shared top-level numbers ----------------
const { cells, runs, medianBudgetMs } = budget
if (![cells, runs, medianBudgetMs].every((v) => typeof v === 'number' && v > 0)) {
  fail(GATE, `${BUDGET_PATH} must carry positive numbers for cells, runs, medianBudgetMs`)
}

// ---- legacy single-subject path (0.1.4 budgets) ---------------------------------
if (typeof budget.subject === 'string' && budget.subject.trim() !== '') {
  // Content-conditional NOTE, not a rampNote: the budget file is SEEDED, so the
  // newer shape arrives only by a deliberate human pull — name it and the command.
  console.log(
    `${GATE}: NOTE — ${BUDGET_PATH} uses the legacy single-subject shape; current budgets declare subjects: [{ subject, cells, medianBudgetMs }] and arm the dense-feature closure scan (every features/* dir importing useVirtualWindow/useRovingGrid must ship a measured perfSubject.ts). ${BUDGET_PATH} is seeded — update never rewrites it; adopt deliberately with \`npx tauri-postgres-agent-harness update --refresh-seeded tools/perf-budget.json\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
  const subjectAbs = resolve(process.cwd(), budget.subject)
  if (!existsSync(subjectAbs)) {
    fail(
      GATE,
      `budget.subject "${budget.subject}" does not exist (resolved ${subjectAbs}) — the declared perf subject is missing; restore it or drop "subject" from ${BUDGET_PATH}`,
    )
  }
  ok(GATE, measureWithRetry({ subject: budget.subject, cells, runs, medianBudgetMs }))
}

// ---- legacy synthetic path (budgets without a subject, pre-0.1.4) --------------
let React
let renderToString
try {
  const requireFromDesktop = createRequire(`${process.cwd()}/apps/desktop/package.json`)
  React = requireFromDesktop('react')
  ;({ renderToString } = requireFromDesktop('react-dom/server'))
} catch {
  skipOrFail(GATE, 'react/react-dom not resolvable from apps/desktop (run pnpm install)')
}

const SIDE = Math.round(Math.sqrt(cells))

// Synthetic matrix: rows×cols of cells with data-derived classes and text —
// the same order of DOM weight a real matrix screen produces per render.
function matrixElement() {
  const rows = []
  for (let r = 0; r < SIDE; r += 1) {
    const rowCells = []
    for (let c = 0; c < SIDE; c += 1) {
      const value = (r * 31 + c * 17) % 100
      rowCells.push(
        React.createElement(
          'td',
          {
            key: c,
            className: value > 50 ? 'cell cell-high' : 'cell cell-low',
            'data-value': value,
          },
          String(value),
        ),
      )
    }
    rows.push(React.createElement('tr', { key: r }, rowCells))
  }
  return React.createElement(
    'table',
    { className: 'matrix' },
    React.createElement('tbody', null, rows),
  )
}

function measureMedian() {
  // Warmup: JIT + module init noise stays out of the measured runs.
  for (let i = 0; i < 2; i += 1) renderToString(matrixElement())
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    const html = renderToString(matrixElement())
    samples.push(performance.now() - start)
    // Sanity: the render actually produced the matrix (an empty render would be
    // a vacuously fast "pass").
    if (!html.includes('cell-high'))
      fail(GATE, 'fixture rendered no cells — measurement is vacuous')
  }
  samples.sort((a, b) => a - b)
  return { median: samples[Math.floor(samples.length / 2)], samples }
}

let { median, samples } = measureMedian()
let retried = false
if (median > medianBudgetMs) {
  // One full re-measure before failing: two independent over-budget medians
  // cannot both be scheduler noise.
  retried = true
  ;({ median, samples } = measureMedian())
}

const detail = `${SIDE}×${SIDE} cells, ${runs} runs${retried ? ' (re-measured once)' : ''}: median ${median.toFixed(1)}ms (budget ${medianBudgetMs}ms; samples ${samples.map((s) => s.toFixed(0)).join('/')}ms)`

if (median > medianBudgetMs) {
  fail(
    GATE,
    `${detail} — render cost regressed past the budget twice in a row. Find the regression (or, after a DELIBERATE fixture change, re-baseline tools/perf-budget.json in a reviewed commit).`,
  )
}
ok(GATE, detail)
