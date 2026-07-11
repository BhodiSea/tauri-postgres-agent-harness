#!/usr/bin/env node
// Deterministic CI mirror of .claude/hooks/posttool-source-check.mjs — the PostTool hook
// only fires inside Claude Code; this runs the IDENTICAL heuristic over the whole tracked
// tree in `pnpm validate` + CI so unsourced decision sites are caught on every PR, not just
// during an edit. Both layers import the heuristic from tools/lib/provenance-rules.mjs —
// one source of truth, drift is structurally impossible.
//
// Beyond the hook's fast presence check, this gate enforces RESOLVABILITY and
// (v0.1.5, version-ramped) JUSTIFICATION:
//   1. every SOURCE payload must ground somewhere real — a corpus reference, a
//      repo-relative path that exists, or an https:// URL whose host is on the
//      shared allowlist in tools/lib/citation-domains.mjs (an arbitrary URL is
//      a claim, not an authority);
//   2. every corpus reference anywhere in the tracked tree must resolve to an
//      entry in tools/mcp/corpus/index.json;
//   3. the corpus itself is tamper-evident data — each entry carries a sha256
//      over its text, non-empty title/url/version, and the entries' `groups`
//      tags must cover every decision group the heuristic can flag;
//   4. group-match: a decision site citing a corpus entry that declares
//      `groups` must cite one covering the site's OWN decision group — a
//      resolvable citation that grounds a different decision class is not
//      justification. Entries without `groups` stay presence-checked
//      (consumer-added entries are never forced into the taxonomy); reviewed
//      cross-group escapes live in tools/provenance-overrides.json.
// Checks 1's host-allowlist and 4 went live in 0.1.5 and are rampNote-gated:
// NOTE-only on pre-0.1.5 baseVersion installs, hard on fresh installs and the
// template tree. The per-edit hook enforces NEITHER (see provenance-rules.mjs:
// no corpus load per edit, no ramp per edit — a hook can only block or pass).
// SOURCE: docs/harness/README.md (the gate is the enforcement; provenance) [corpus: harness/doctrine]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { isAllowedCitationHost } from './lib/citation-domains.mjs'
import { fail, MAX_BUFFER, ok, rampNote } from './lib/gate.mjs'
import {
  CORPUS_REF,
  DECISION_GROUPS,
  extractHttpsUrlHosts,
  extractSourceComments,
  findCitedDecisionSites,
  findUncitedDecisionSites,
  gateFileMatch,
  gateScansFile,
  payloadResolves,
} from './lib/provenance-rules.mjs'

// cwd-relative like every other gate (fixtures and scaffolds carry their own corpus).
const CORPUS_PATH = 'tools/mcp/corpus/index.json'
// Reviewed cross-group citation escapes. ABSENT is fine and means "no escapes"
// (the file is seedOnInitOnly — pre-0.1.5 installs never receive it and the
// ramped checks are NOTE-only there anyway); MALFORMED fails closed — the file
// is write-guard-protected, so unparseable content is tampering, not config.
const OVERRIDES_PATH = 'tools/provenance-overrides.json'
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
const problems = [] // resolvability + corpus-integrity failures (never ramped)
const ramped = [] // v0.1.5 semantic findings: group-match + URL-host allowlist
const citedSites = [] // cited decision sites, held for the corpus group-match below

// ── 0. reviewed cross-group overrides: schema-validated, fail closed ──────────
// Shape: { comment: string, entries: [{ file, group, id, reason }] } — every
// field a non-empty string, group a known decision-group key, no extra keys
// (a typo'd key would silently grant nothing while a reviewer believes it did).
const overrides = []
if (existsSync(OVERRIDES_PATH)) {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'))
  } catch (e) {
    fail(
      'provenance',
      `${OVERRIDES_PATH} is not valid JSON (${e.message}) — it is write-guard-protected, so a corrupt overrides file is tampering; restore it from git history`,
    )
  }
  const groupKeys = new Set(DECISION_GROUPS.map((g) => g.key))
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof raw.comment !== 'string' ||
    !Array.isArray(raw.entries)
  ) {
    problems.push(
      `${OVERRIDES_PATH}: expected { comment: string, entries: array } — malformed overrides fail closed`,
    )
  } else {
    raw.entries.forEach((entry, i) => {
      const errs = []
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(
          `${OVERRIDES_PATH}: entries[${String(i)}] is not an object — malformed overrides fail closed`,
        )
        return
      }
      for (const field of ['file', 'group', 'id', 'reason']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
          errs.push(`missing/empty ${field}`)
        }
      }
      for (const key of Object.keys(entry)) {
        if (!['file', 'group', 'id', 'reason'].includes(key))
          errs.push(`unknown key ${JSON.stringify(key)}`)
      }
      if (typeof entry.group === 'string' && entry.group !== '' && !groupKeys.has(entry.group)) {
        errs.push(
          `unknown decision group ${JSON.stringify(entry.group)} (known: ${[...groupKeys].join(', ')})`,
        )
      }
      if (errs.length) {
        problems.push(
          `${OVERRIDES_PATH}: entries[${String(i)}]: ${errs.join('; ')} — malformed overrides fail closed`,
        )
        return
      }
      overrides.push(entry)
    })
  }
}

// ── 1. decision sites need a SOURCE, and every SOURCE must resolve ────────────
for (const file of tracked.filter(gateFileMatch).filter(gateScansFile)) {
  const src = read(file)
  if (src === null) continue
  for (const f of findUncitedDecisionSites(src)) {
    uncited.push(`${file}:${f.line}  ${f.excerpt}`)
  }
  for (const site of findCitedDecisionSites(src)) {
    citedSites.push({ file, ...site })
  }
  for (const s of extractSourceComments(src)) {
    if (payloadResolves(s.payload)) continue
    // Distinguish the v0.1.5 host-allowlist miss (ramped) from a payload that
    // grounds nowhere at all (a resolvability failure since v0.1.1 — never ramped).
    const badHosts = extractHttpsUrlHosts(s.payload).filter((h) => !isAllowedCitationHost(h))
    if (badHosts.length) {
      ramped.push(
        `${file}:${s.line}  SOURCE cites URL host(s) not on the citation allowlist: ${badHosts.join(', ')} — ` +
          `pin the authority in ${CORPUS_PATH} and cite [corpus: <id>] (extend the corpus in the same PR), ` +
          'or add the domain to tools/lib/citation-domains.mjs via a reviewed human edit',
      )
    } else {
      problems.push(
        `${file}:${s.line}  SOURCE payload resolves to nothing — need an allowlisted https:// URL, ` +
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

// ── 2b. group-match: cited corpus entries must justify the decision class ─────
// For each cited decision site, the UNION of the cited entries' `groups` must
// cover every group the site's line matched. Entries that declare no `groups`
// are wildcards (per-entry self-disable: consumer-added corpus entries are
// never forced into the taxonomy — citing one keeps v0.1.4 presence semantics
// for the whole site). Unknown cited ids are already failed by sweep 3 below,
// so they are simply skipped here. Reviewed { file, group, id } overrides
// accept a specific cross-group pairing.
if (corpus !== null) {
  const entryGroups = new Map()
  for (const entry of corpus) {
    if (typeof entry?.id === 'string' && entry.id !== '') {
      entryGroups.set(entry.id, Array.isArray(entry.groups) ? entry.groups : null)
    }
  }
  for (const site of citedSites) {
    const refs = [...site.payload.matchAll(CORPUS_REF)].map((m) => m[1])
    const known = refs.filter((id) => entryGroups.has(id))
    if (known.length === 0) continue // URL/path citation, or unresolvable ids (sweep 3 reds those)
    if (known.some((id) => entryGroups.get(id) === null)) continue // wildcard: a groups-less entry is cited
    const covered = new Set(known.flatMap((id) => entryGroups.get(id)))
    for (const g of site.groups) {
      if (covered.has(g)) continue
      if (overrides.some((o) => o.file === site.file && o.group === g && refs.includes(o.id))) {
        continue
      }
      const cited = known.map((id) => `${id} (groups: ${entryGroups.get(id).join(', ') || 'none'})`)
      ramped.push(
        `${site.file}:${site.line}  decision group '${g}' is not justified by the cited corpus ` +
          `entr${known.length === 1 ? 'y' : 'ies'} ${cited.join('; ')} — cite an entry whose groups ` +
          `include '${g}' (extend ${CORPUS_PATH} in the same PR if the authority is missing), or add ` +
          `a reviewed { file, group, id, reason } entry to ${OVERRIDES_PATH}`,
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

// ── ramp: the v0.1.5 semantic checks (group-match + host allowlist) ───────────
// rampNote is called LAZILY — only when there ARE would-be findings — so green
// trees emit no ramp noise. Pre-0.1.5 baseVersion installs get each finding as
// an actionable NOTE and still pass; fresh installs and the template tree fail.
let rampSummary = 'group-match + URL-host allowlist clean'
if (ramped.length) {
  if (
    rampNote(
      'provenance',
      '0.1.5',
      'semantic citation checks (corpus decision-group match + bare-URL host allowlist)',
    )
  ) {
    for (const f of ramped) console.log(`provenance: NOTE — (ramp) ${f}`)
    rampSummary = `${String(ramped.length)} semantic finding(s) withheld by the pre-0.1.5 ramp`
  } else {
    problems.push(...ramped)
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
    `Provenance gate (check:sources): ${String(problems.length)} citation-resolvability / corpus-integrity / citation-justification failure(s):\n` +
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
  `check:sources — corpus verified: ${String(corpus.length)} entr(ies) hash-clean, all corpus refs resolve, ${String(coveredGroups.size)}/${String(knownGroupKeys.size)} decision groups covered; ${rampSummary}\n`,
)
ok('provenance', 'resolvable, group-matched citations over a tamper-evident corpus')
