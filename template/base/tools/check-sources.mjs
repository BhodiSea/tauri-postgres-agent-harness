#!/usr/bin/env node
// Deterministic CI mirror of .claude/hooks/posttool-source-check.mjs — the PostTool hook
// only fires inside Claude Code; this runs the IDENTICAL heuristic over the whole tracked
// tree in `pnpm validate` + CI so unsourced decision sites are caught on every PR, not just
// during an edit. Both layers import the heuristic from tools/lib/provenance-rules.mjs —
// one source of truth, drift is structurally impossible.
//
// Beyond the hook's fast presence check, this gate enforces RESOLVABILITY:
//   1. every SOURCE payload must ground somewhere real — an https:// URL, a
//      repo-relative path that exists, or a corpus reference;
//   2. every corpus reference anywhere in the tracked tree must resolve to an
//      entry in tools/mcp/corpus/index.json;
//   3. the corpus itself is tamper-evident data — each entry carries a sha256
//      over its text, non-empty title/url/version, and the entries' `groups`
//      tags must cover every decision group the heuristic can flag.
// SOURCE: docs/harness/README.md (the gate is the enforcement; provenance) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, MAX_BUFFER, ok } from './lib/gate.mjs'
import {
  CORPUS_REF,
  DECISION_GROUPS,
  extractSourceComments,
  findUncitedDecisionSites,
  gateFileMatch,
  gateScansFile,
  payloadResolves,
} from './lib/provenance-rules.mjs'

// cwd-relative like every other gate (fixtures and scaffolds carry their own corpus).
const CORPUS_PATH = 'tools/mcp/corpus/index.json'
// Never regex binary blobs in the tree-wide corpus-reference sweep.
const BINARY_FILE =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|exe|dll|so|dylib|gguf|node)$/i

function trackedFiles() {
  // ONE bare `git ls-files` for the whole gate (was two): the gate-file sweep filters
  // this with gateFileMatch in-process (replacing the old GATE_FILE_GLOBS pathspecs),
  // the corpus sweep filters out binaries. execFileSync, never a shell — no argv to
  // glob and nothing for sh to mangle. MAX_BUFFER: a large monorepo (or a force-tracked
  // node_modules) ENOBUFS-crashes node's 1 MB default instead of a named gate error.
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
}

// Enumerate the tracked tree exactly once; both sweeps below reuse it.
const tracked = trackedFiles()

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const uncited = [] // decision sites with no SOURCE in the window (hook parity)
const problems = [] // resolvability + corpus-integrity failures

// ── 1. decision sites need a SOURCE, and every SOURCE must resolve ────────────
for (const file of tracked.filter(gateFileMatch).filter(gateScansFile)) {
  const src = read(file)
  if (src === null) continue
  for (const f of findUncitedDecisionSites(src)) {
    uncited.push(`${file}:${f.line}  ${f.excerpt}`)
  }
  for (const s of extractSourceComments(src)) {
    if (!payloadResolves(s.payload)) {
      problems.push(
        `${file}:${s.line}  SOURCE payload resolves to nothing — need an https:// URL, ` +
          `an existing repo-relative path, or a corpus reference (got: ${JSON.stringify(s.payload.trim().slice(0, 80))})`,
      )
    }
  }
}

// ── 2. corpus integrity: tamper-evident, well-formed, group-covering ──────────
let corpus = null
if (!existsSync(CORPUS_PATH)) {
  problems.push(`${CORPUS_PATH}: missing — the pinned corpus is part of the provenance surface`)
} else {
  try {
    corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
  } catch (e) {
    problems.push(`${CORPUS_PATH}: invalid JSON (${e.message})`)
  }
  if (corpus !== null && !Array.isArray(corpus)) {
    problems.push(`${CORPUS_PATH}: expected an ARRAY of entries`)
    corpus = null
  }
}

const knownIds = new Set()
const knownGroupKeys = new Set(DECISION_GROUPS.map((g) => g.key))
const coveredGroups = new Set()
if (corpus !== null) {
  for (const entry of corpus) {
    const id = typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id : null
    if (id === null) {
      problems.push(
        `${CORPUS_PATH}: entry with missing/empty id: ${JSON.stringify(entry).slice(0, 80)}`,
      )
      continue
    }
    knownIds.add(id)
    for (const field of ['title', 'url', 'version']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        problems.push(
          `corpus entry ${id}: missing/empty ${field} — pinned entries must name their authority`,
        )
      }
    }
    if (typeof entry.text !== 'string' || entry.text.trim() === '') {
      problems.push(`corpus entry ${id}: missing/empty text — nothing to hash, nothing cited`)
      continue
    }
    const actual = createHash('sha256').update(entry.text, 'utf8').digest('hex')
    if (entry.sha256 !== actual) {
      problems.push(`corpus entry ${id} text/hash mismatch — the corpus is tamper-evident data`)
    }
    if (entry.groups !== undefined) {
      if (!Array.isArray(entry.groups)) {
        problems.push(`corpus entry ${id}: groups must be an array of decision-group keys`)
      } else {
        for (const g of entry.groups) {
          if (knownGroupKeys.has(g)) {
            coveredGroups.add(g)
          } else {
            problems.push(
              `corpus entry ${id}: unknown decision group ${JSON.stringify(g)} (known: ${[...knownGroupKeys].join(', ')})`,
            )
          }
        }
      }
    }
  }
  // Depth lockstep: the heuristic must never flag a decision class the corpus
  // cannot ground — every group needs at least one authorizing entry.
  for (const g of DECISION_GROUPS) {
    if (!coveredGroups.has(g.key)) {
      problems.push(
        `decision group '${g.key}' (${g.description}) has no corpus entry tagged groups: ["${g.key}"] in ${CORPUS_PATH}`,
      )
    }
  }
}

// ── 3. every corpus reference in the tracked tree must resolve ────────────────
if (corpus !== null) {
  for (const file of tracked.filter((f) => !BINARY_FILE.test(f))) {
    const src = read(file)
    if (src === null || !src.includes('[corpus:')) continue
    src.split('\n').forEach((ln, i) => {
      for (const m of ln.matchAll(CORPUS_REF)) {
        if (!knownIds.has(m[1])) {
          problems.push(
            `${file}:${i + 1}  [corpus: ${m[1]}] does not resolve to any entry in ${CORPUS_PATH}`,
          )
        }
      }
    })
  }
}

if (uncited.length) {
  process.stderr.write(
    `Provenance gate (check:sources): ${String(uncited.length)} decision site(s) lack an inline ` +
      '`// SOURCE:` (`-- SOURCE:` in SQL) citation. Add `SOURCE: <authoritative URL or doc id>` ' +
      'on/above each, then re-run /verify-citations:\n' +
      `${uncited.join('\n')}\n`,
  )
}
if (problems.length) {
  process.stderr.write(
    `Provenance gate (check:sources): ${String(problems.length)} citation-resolvability / corpus-integrity failure(s):\n` +
      `${problems.join('\n')}\n`,
  )
}
if (uncited.length || problems.length) {
  fail(
    'provenance',
    `${String(uncited.length + problems.length)} provenance failure(s) — details above`,
  )
}

process.stdout.write('check:sources — all decision sites carry SOURCE citations (0 flagged)\n')
process.stdout.write(
  `check:sources — corpus verified: ${String(corpus.length)} entr(ies) hash-clean, all corpus refs resolve, ${String(coveredGroups.size)}/${String(knownGroupKeys.size)} decision groups covered\n`,
)
ok('provenance', 'resolvable citations over a tamper-evident corpus')
