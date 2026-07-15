# Changelog

All notable changes to the harness are documented here. Consuming projects
pick up fixes with `npx --yes github:BhodiSea/tauri-postgres-agent-harness update`.

## [0.1.6] — 2026-07-15

The four pillars become floors. A 50-agent adversarial audit of v0.1.5
(8 read-only lens assessors → 30 deduped findings → one skeptic per finding
instructed to *refute* → completeness critic → grade synthesis; record in
`design/v0.1.6-audit.md`) found the enforcement was real but **pinned to the two
shipped exemplar surfaces** and **defeatable at the trust root** — and the
flagship write-UX exemplar 401'd against its own server while all 22 gates, 45
e2e tests and the perf lane stayed green. Every confirmed path got a
deterministic countermeasure (gate/hook **or blocking CI lane** — the harness's
own doctrine). The 22-step floor is unchanged; the work is depth inside existing
gates, new CI lanes, four new Stop-chain non-floor steps, and the scaffold itself
fixed to be the benchmark it claims.

Honest note on how this release was built: the same adversarial method was turned
on the *new* work. Two review passes over the machinery-self-bar changes alone
found nine real defects in code that had already passed every gate — a hidden
auth bypass, a mutation lane that had never run, a complexity ratchet that could
be fooled by a same-named function, a canary check that misjudged an empty proof.
Each is fixed and canary-proven. Where a control cannot deliver its full promise,
the docs now say so plainly rather than over-claim.

**What `update` does for an existing 0.1.5 install**: owned surfaces refresh as
usual, and **a clean 0.1.5 (or 0.1.4) consumer stays green** — the update-skew
matrix gained a **v0.1.5 leg** alongside 0.1.4. Every new v0.1.6 check activates
by data shape you control or is `rampNote`-gated to `baseVersion >= 0.1.6`: it
prints `NOTE — (ramp)` on your pre-0.1.6 vintage and turns fatal only after you
graduate deliberately (`npx … graduate`, which refuses while any ramp NOTE
stands). The native perf floor is withheld whole (its budget names *your*
`#[tauri::command]` surface and its bench lives in the crate — adopt with
`update --refresh-seeded tools/native-perf-budget.json apps/desktop/src-tauri/benches/`),
i18n's turn-fatal gate ramps so your existing English literals don't ambush an
upgrade, and the new seeded clusters (status-color tokens, the i18n catalog, the
authenticated api-client, the DAL query-shape registry, the mutation baseline)
are `seedOnInitOnly` — the selftest gate makes forgetting one machine-impossible.

- **Trust root closed** (the criticals): the write-guard now `realpath`-resolves a
  target before matching the protected set, so a symlink can no longer shadow a
  gate script; `.harness/manifest.json` gained a root of trust (git-verified
  monotonic `baseVersion`, consumer-CI regeneration from the SHA-pinned tag, and
  its own metadata folded into `gate-integrity`), so a hand-lowered `baseVersion`
  can no longer silently downgrade live checks in CI. `tsconfig(.base).json`
  joined the protected files; interpreter/patch write-classes (`node -e`,
  `git apply`, `dd of=`, …) joined the bash-guard; and the seeded escape lists
  (`rls-exempt.json` and kin) are now tamper-evident.
- **Research-grade**: the citation obligation extends past the six hard-wired
  stack classes — a project's own `research/` constants carry a citation duty via
  a write-guard-protected decision-group file, groups-less corpus entries are now
  a hard error (the ~25 universal justifiers are gone), and the semantic checks
  auto-graduate instead of noting forever. The produced artifact is finally
  citable: seeded LICENSE + CITATION.cff + `license` field, a claims gate that
  recomputes the machine-derivable README/CHANGELOG numbers (it caught a real
  cold/warm contradiction between the two docs), and a network fidelity job that
  fetches every corpus URL (it caught a dead `tauri/isolation` link).
- **UI/UX**: the flagship exemplar actually works — one authenticated api-client
  primitive attaches the host-held bearer token, and a new blocking integration
  lane drives create → list → paginate through the *real* desktop fetch → Hono →
  Postgres seam (it also surfaced that the server shipped with **no CORS at
  all**). Semantic status color arrives as contrast-computed `--color-danger` /
  `--color-success` tokens (a failed-write toast is no longer identical to a
  confirmation), a status-channel scan reds a colorless `role=alert`, and route
  quality generalizes off ROUTES: empty/loading states must render through
  `EmptyState`/`Skeleton`, per-route keyboard focus and a 640×480 reflow sweep run
  over every registered screen. i18n is a turn-fatal seam (typed catalog, `Intl`
  formatting, `lang`/`dir` management) with a pseudo-locale + RTL e2e lane.
- **Performance**: the native host is measured for the first time. Criterion
  benches drive the **real** `#[tauri::command]` invoke path and the real boot
  chain (a Stop-chain closure requires *every* command to be benched and
  budgeted), with budgets expressed as **ratios** to the cheapest command — a
  design chosen only after measuring that a synthetic-calibration normalizer was
  worse than none. A real-binary cold-start TTI budget runs nightly. Perf closure
  generalizes off ROUTES + `subjects[]` (a dense screen an agent adds is now
  measured), a marker-scale anti-vacuity check kills the 1-row degenerate subject,
  a CI-side render/gzip baseline ratchet closes the drift band, a CDP heap loop
  catches leaks, and every DAL query shape is `EXPLAIN`-probed at scale for a Seq
  Scan or external sort.
- **Maintainability**: mutation testing goes default-on (StrykerJS, a set-based
  ratchet against a reasoned baseline, blocking per-PR on the critical set +
  nightly full) — it found a **JWT audience bypass**, a missing `DELETE` CORS
  method, a `500`-where-`400`, and a password-leaking crash redactor, all with
  every gate green. Coverage's blind spot is covered by a Stop-chain
  assertion-presence gate (honestly documented as gameable alone — mutation is the
  real control). A jscpd duplication gate and a bounded-DTO `.max()` sweep land.
  And **the machinery finally obeys its own bar**: a data-driven complexity
  ratchet replaces the prose promise that `init()` "may not grow" (nothing had
  enforced it — four machinery checks were in fact red), the canary registry now
  *executes* each red-proof instead of checking it exists, and a config-rule
  integrity check pins the depcruise/eslint boundary rules a deleted or
  regex-narrowed rule could silently neuter.

## [0.1.5] — 2026-07-12

The promise becomes checkable. A 42-agent audit (8 lens assessors → 30
adversarial verifiers → completeness critic → 3 release designers; distilled
record in `design/v0.1.5-audit.md`) named every way an agent could end a turn
green while the four pillars quietly weren't true — and each named path got a
deterministic countermeasure. No new names in the 22-step chain (the floor is
unchanged); the depth is inside existing gates, one new Stop-chain step, two
CI-only lanes, and the scaffold itself raised to be the benchmark it claims.

**What `update` does for an existing 0.1.4 install** (lead story): owned
surfaces (gate scripts, hooks, e2e specs, corpus, agent roster, workflows)
refresh as usual, and **a clean 0.1.4 consumer stays green — now a CI
invariant, not a convention**: the update-skew matrix gained a v0.1.4 leg that
runs `pnpm install` + the full 22-gate validate after `update` on every PR.
The mechanics: `.harness/manifest.json` gains `baseVersion` (your pre-update
vintage; future updates preserve it), and the semantic-provenance checks print
`NOTE — (ramp)` findings instead of reds until you sweep and graduate
deliberately (`docs/runbooks/harness-upgrade.md`). Everything else activates
by data shape you control: perf closure when your budget adopts `subjects[]`,
the primitive-boundary scan when your styleguide manifest gains
`controlPrimitives`, the gzip ratchet when `perf-baseline.json` exists
(regenerate from **your** bytes via `pnpm perf:baseline`, don't pull the
template's), and diff-coverage is inherently safe (empty diff passes — only
code you change after upgrading is held to the per-file floors). The ~30 new
seeded exemplar files (features/notes write slice, `Field` primitive, the
deeper palette, the three new budget/override JSONs) are withheld as
`seedOnInitOnly` — and a new selftest gate diffs every release against the
previous tag, so *forgetting* a seedOnInitOnly registration is now
machine-impossible. Pull clusters on your terms with `update --refresh-seeded
<path>`.

- **Research-grade**: provenance now checks that a citation *justifies*, not
  merely resolves — a `[corpus: id]` cite at a decision site of group G must
  cite an entry whose `groups` cover G (cross-group escapes live in reviewed,
  write-guard-protected `tools/provenance-overrides.json`), and a bare URL
  grounds a citation only on a `citation-domains.mjs` allowlisted host (one
  list, shared with the citation-verifier agent). The dual-license claim is
  machine-verifiable: REUSE 3.3 compliant (`REUSE.toml` + `LICENSES/`,
  `Apache-2.0 OR 0BSD` on `template/**`), `reuse lint` blocking in CI with a
  dependency-free offline mirror. "Reviewers are read-only by construction"
  is now a gate: docs-sync parses every agent's frontmatter and reds a
  reviewer granted Write/Edit/Bash (fail-closed on unparseable frontmatter).
- **Maintainability**: per-file coverage floors (50/40/45/50 under the
  70/60/65/70 aggregates) plus a new `diff-coverage` Stop-chain step — every
  changed or untracked source file must appear in the coverage map and clear
  the floors, so the 0%-covered-feature aggregate dodge is closed. And the
  machinery obeys its own bar: blocking repo CI runs eslint (cognitive
  complexity 15, the consumer budget, with an honest 11-site ratchet —
  `init()` measures 133 today and may not grow), `tsc --checkJs`, and knip
  over ~5,200 LOC of installer/gate/hook code. The new lint immediately paid
  for itself: a mangled dead test helper and two silent empty catches.
- **UI/UX**: the doctrine finally has a write-path exemplar — an optimistic
  create-note slice (`Field` primitive with computed aria wiring, ONE reducer:
  temp-id head insert → reconcile-by-id or single-path rollback + envelope
  toast), locked by a held-POST e2e spec that proves the optimistic row
  renders *before* fulfillment. The command palette grows up: deterministic
  DP fuzzy ranking (fast-check properties against an independent oracle),
  required typed `group`, subtitle + `keys` hints derived from the shortcut
  registry, capped localStorage recents (empty-query only — recency never
  biases ranking), and typed contextual commands contributed by screens.
  Interactive controls through primitives is now gate-red (`controlPrimitives`
  source scan; the shipped tree passes armed with zero exemptions). Contrast:
  the primary reading pairs are **AAA (7:1), computed, both themes**
  (measured 15.8/14.4 dark, 14.7/13.0 light — pure manifest data, no retune
  needed; ink-muted stays honestly AA), plus a principled
  `forced-colors: active` layer and a Windows High Contrast e2e lane with a
  no-preference control. The e2e lane: 30 → 45 tests, retries still 0.
- **Performance**: perf-budget closes over every dense feature —
  `subjects[]` budgets measured through the same median-of-7 path, and a
  feature dir importing `useVirtualWindow`/`useRovingGrid` without a declared
  `perfSubject.ts` is gate-red (reviewed `exempt` escape). Regressions are
  now measured against a **committed baseline**, not a 10× cliff: gzip total
  164,280 B × ratioCap 1.25 (the 250 KB absolute cap remains as backstop),
  re-baselined only by `pnpm perf:baseline` in a reviewed commit; the nightly
  Windows smoke asserts installer size. Wall-clock UX gets its own blocking
  CI lane — deliberately **outside** the Stop chain (warm validate stays
  ≈6 s): TTI, in-page rAF-bracketed ArrowDown→frame median, and a longtask
  ceiling, with a selftest busy-loop canary proving the lane can red (303 ms
  arrow median and 24 long tasks fail decisively).
- **Permission posture**: the shipped settings allow Bash/WebFetch/WebSearch
  wholesale — the deterministic PreToolUse guards, not permission prompts,
  are the enforcement layer; prompts remain only for genuinely irreversible
  surfaces, and the tamper-evidence deny layer is byte-unchanged.
- **Fixed (fail-open class)**: three shipped scripts weren't biome-clean, so
  a truly fresh (or strict-tier) scaffold's `format` gate went red before the
  agent wrote a line; `e2e/mutation.spec.ts` drove the note composer
  unconditionally, which would have redded an upgraded 0.1.4 consumer — the
  new skew invariant caught it before CI ever did (capability-gated now).
- 558 → 674 harness tests; canary registry 25 → 26 steps / 56 → 60 guard-rule
  ids, all provably red; measured on the final scaffold: cold ≈85 s (real
  cargo + 45 chromium tests), warm ≈6 s.

## [0.1.4] — 2026-07-11

The four pillars deepened. The reference UI becomes a real gate subject (a
virtualized matrix exemplar, shared primitives, light/dark parity with
**computed** WCAG contrast), the machinery is deduplicated and unit-tested
(205 → 558 harness tests), and warm validate drops to ≈5 s for all 22 gates
(stamped e2e, pooled report-all) — measured cold ≈76 s with real cargo +
30 chromium e2e tests on the fresh scaffold.

**What `update` does for an existing install** (lead story): all owned gate
scripts, hooks, e2e specs, and the corpus refresh as usual. The ~28 new seeded
desktop exemplar files (features/matrix, screens/, theme/, router, the
component primitives) are **withheld** — a new `seedOnInitOnly` migration kind
stops `update` from planting files your seeded `routes.ts` never references
(which would red route-manifest + dead-code). Each withheld cluster emits a
note; pull on your terms with `update --refresh-seeded <path>` (now accepts
directory prefixes). After pulling `features/matrix`, register the screen in
`routes.ts` (or pull the new `routes.ts` too — pristine seeded files refresh,
drifted ones park) — route-manifest's FIX line walks you through it. The new
styleguide/perf-budget checks self-disable on pre-0.1.4 manifests, except the
arbitrary-value scan (tokens-only hardening; `allow` entries are the escape).

- **UI/UX**: shared `src/components` primitives (Button/Input/Skeleton/Toast/
  EmptyState) replace four hand-repeated inline button styles (accent usage
  4/10 of budget); light + dark themes with `prefers-color-scheme` tracking, a
  persisted three-state toggle, palette commands, and a dark launch frame in
  both themes (anti-flash, lockstep with tauri.conf backgroundColor); explicit
  `prefers-reduced-motion` support; a hand-rolled router with a lazy-loaded
  second route; and `features/matrix` — the doctrine's data-dense exemplar:
  pure virtual-window math, an APG roving-tabindex grid reporting
  `aria-rowcount` over a windowed DOM, keyset pagination wired to the server's
  `{ items, nextCursor }` contract, and a hand-rolled SVG summary strip.
- **Styleguide gate computes contrast**: the prose contrast table in styles.css
  is replaced by `tools/lib/oklch.mjs` (CSS Color 4 conversion → WCAG relative
  luminance) verifying every manifest-declared fg/bg pair in BOTH themes —
  6 pairs computed green (the shipped light accent was out of sRGB gamut and
  failing 4.5:1 as text; retuned to `oklch(0.475 0.08 200)`). Theme-block token
  closure (a light override missing a token fails loudly), and Tailwind
  arbitrary-value escapes (`w-[13px]`, `[prop:value]`, `-(--var)`) are gate-red.
- **perf-budget measures the real component**: `budget.subject` spawns
  `features/matrix/perfSubject.ts` under tsx (median-of-7 renderToString of the
  actual 10k-cell grid, ~40 ms local, budget 500 ms), anti-vacuous
  (`role="gridcell"` asserted), and an unresolvable subject FAILS — never a
  silent synthetic fallback. route-manifest adds canonical-path validity,
  duplicate-path, and state-test-id uniqueness checks.
- **e2e lane 15 → 30 tests**: every route axe-swept in BOTH themes; a
  reduced-motion lane proving the held loading skeleton runs zero animations
  (with a no-preference control proving the assert can red); a matrix lane
  proving single-tab-stop roving focus, real virtualization, and cursor
  forwarding. 3× consecutive runs flake-free; `retries` stays 0.
- **Warm validate ≈5 s**: the e2e and version-sync gates are content-hash
  stamped (a vacuous run never stamps; CI always re-runs — the selftest warm
  lane greps the stamp skip as a positive control), and `--report-all` (the
  Stop-hook path) runs the 11 read-only gates through a concurrency pool with
  canonical-order output. Cold ≈76 s (rust-check dominates at ~51 s).
- **FLOOR is a frozen snapshot**: `tools/validate.floor.json` replaces the
  hand-copied array in validate.mjs — `--min-floor` fails CLOSED on a missing/
  corrupt snapshot, `scripts/generate-floor.mjs --check` + a data-to-data test
  end the hand-sync, and the file is write-guard protected (34 → 33 real
  patterns + 1: the old count regex had been counting two comment lines).
- **Guard rules are data with per-rule falsifiability**: both guards load their
  tables from `hooks/lib/guard-rules.mjs` (import failure = BLOCKED, exit 2);
  check-canary-coverage asserts every one of the 56 rule ids has a behavioral
  deny/allow canary (three brittle count-regexes deleted; closure surfaced
  three previously untested rules: fork-bomb, drizzle-kit-drop,
  minisign-secret-key) and pins the inline denyTool call-site counts.
- **Fixed (fail-open)**: the provenance sweep's git pathspecs silently skipped
  files directly under `apps/` and `packages/` (`apps/**/*.ts` requires an
  intermediate directory) — `gateFileMatch()` widens the sweep fail-closed and
  one bare `git ls-files` serves both sweeps.
- **Machinery quality**: one dirent-based walker per side replaces ~12 drifted
  copies (directory-only pruning; a broken symlink can no longer crash
  doctor's scan); `writeInstallFile` re-asserts the executable bit on
  overwrite; update's plan loop and refresh-seeded share one pure
  `classifyDrift()`; doctor renders only seeded entries and `--refresh-seeded`
  renders only the requested paths. 558 harness tests (was 205): logic-level
  suites for 8 previously canary-only gates, 9 untested installer libs, hookio
  fail-closed contracts, and a pinned digest vector guarding stamp inputs.
  New CI floors: tools-lib 90/85/85; update-skew is now a [v0.1.1, v0.1.3]
  matrix asserting route-manifest green on the 0.1.3 leg.
- **Docs honesty**: README module list 12 → 10 (the two retired-in-0.1.3
  modules removed; stub-core modules now say what ships wired vs. as a seam);
  CITATION.cff carries version + date-released and check-release-lockstep
  asserts both plus the CHANGELOG section on every PR.

## [0.1.3] — 2026-07-10

The four-pillar milestone: the default chain grows 16 → **22 gates**, every gate
is provably able to fail, and `update` becomes a real cross-version vehicle.
Existing installs receive everything via `update` (gate steps are injected into
the consumer's config, promoted modules fold in, canonical commands heal).

- **New default gates**: `gate-integrity` (sha over the enforcement surface),
  `styleguide` (tokens-only design system — erased Tailwind palette, no raw
  hex/px/inline styles, family closure, accent budget), `perf-budget`
  (median-of-N render budget, re-measure-once), `route-manifest` (every screen
  registered with loading/empty/error states; features-dir closure), `e2e` (the
  whole Playwright lane — axe per state, keyboard walk with computed
  focus-visibility, focus traps — at agent time), `docs-sync` (AGENTS.md gate
  list must equal the chain). `gate-styleguide`/`gate-perf-budget` modules are
  retired (promoted); `enable` explains the promotion.
- **RLS performance is enforced**: owner columns need a leading-column index
  (static gate + pg_catalog check + a 10k-row EXPLAIN plan probe asserting
  index access with a once-per-statement InitPlan — no Seq Scan, no per-row
  SubPlan). The RLS suite now runs on a scratch database (`<db>_rls`) under an
  advisory lock — test runs can no longer drop dev data, and concurrent runners
  serialize instead of corrupting each other.
- **Server exemplar hardened**: one error envelope
  (`{ error: { code, message, requestId } }`) with declared 4xx/5xx everywhere,
  `.max()` bounds on every wire string, `bodyLimit`, keyset pagination
  (`{ items, nextCursor }`, microsecond-faithful cursors) with an unconditional
  DAL LIMIT, a typed drizzle DAL (driver confined to `db/client`, context
  DAL-only — depcruise-enforced), and a statement-count invariance test that
  makes the N+1 class unable to land silently.
- **Trustworthy gates**: the schema-rls parser is statement-level (the v0.1.1
  regex was defeated by the shipped migration's own syntax), provenance
  citations must RESOLVE against a sha-pinned corpus covering every decision
  group, the Stop hook fails CLOSED when an RLS surface exists and no database
  is reachable (after auto-starting docker compose), and every failure carries
  a `FIX[gate]:` line with the exact reproduce command.
- **Falsifiability closure**: `tests/canary/injections.json` registers a
  mechanical red-proof for all 25 steps (validate ∪ Stop chains);
  `scripts/check-canary-coverage.mjs` reds any PR adding a gate without a
  canary or a hook rule without a deny test.
- **Feedback + speed**: `validate --report-all` (the Stop hook shows every red
  at once), per-step elapsed-ms, `eslint --cache`, and content-hash stamps that
  make warm `build`/`contracts`/`licenses`/`rust-check` skip in milliseconds
  (CI always re-runs). Coverage floors run in the Stop hook
  (`vitest run --coverage`) and over the installer itself in CI.
- **Installer**: cross-version migrations (removed/renamed/promotedModules/
  configSteps/configCommandUpdates), `update --refresh-seeded <path>`
  (park-on-drift channel for template improvements to project-owned files),
  doctor advisories (seeded divergence, parked upgrades, dormant lefthook),
  POSIX-normalized manifests with a Windows unit-test matrix, and a module
  render lane proving every module ships placeholder-clean and syntax-valid.
- **Fixed**: ci-windows-e2e drove a nonexistent `<productName>.exe` (Tauri 2
  names the binary after the Cargo bin — `desktop.exe`); the provenance sweep
  ENOBUFS-crashed on large trees (64 MB buffer); pnpm's CI banner polluted the
  openapi regen diff (`--silent`); a jsdom teardown race in the desktop unit
  tests (network-stubbed test setup + RTL cleanup).
- **Fixed**: the e2e lane was timing-flaky on animated loading states — axe
  blends animated opacity into its color-contrast math, so a pulsing skeleton
  read 4.42:1 or 7.8:1 depending on when the snapshot landed. The shipped
  Playwright config now emulates `prefers-reduced-motion` (freezing
  `motion-safe:` utilities), so axe always measures the true resting contrast.
- **Fixed (Windows)**: on native-Windows sessions the write-guard derived the
  project-relative path without normalizing separators, so every root-anchored
  PROTECTED pattern silently failed OPEN — backslash paths now normalize to
  POSIX before matching, and the bash-guard's protected-surface patterns accept
  both separators (deny tests cover the Windows spellings). Also: the
  source-check hook scanned generated bindings on Windows (same separator bug),
  and absolute-path dynamic `import()`s crashed the new Windows unit lanes
  (`pathToFileURL` everywhere).

## [0.1.1] — 2026-07-10

Windows fixes surfaced by the v0.1.0 selftest matrix. The npx channel was
unaffected (tarballs ship LF); the GitHub-template channel on Windows was not.

- **Fixed**: repo-root `.gitattributes` pinning `eol=lf`. Without it, Windows
  clones (CI runners, "Use this template" checkouts) got CRLF working trees,
  the installer copied that verbatim, and the scaffold's biome format gate
  failed on every file. `template/base` already shipped one for consumers;
  the harness repo itself lacked it.
- **Fixed**: tauri-build-smoke asserted the installed binary was
  `<productName>.exe`, but Tauri 2 names it after the Cargo bin
  (`desktop.exe`). The NSIS build, silent install, and uninstall were all
  correct — only the assert was wrong. It now checks for any app exe that
  isn't the uninstaller.
- **Fixed**: the smoke job's path filter now includes `selftest.yml` and
  `.gitattributes` — edits that change the smoke result re-run it instead of
  waiting for the nightly.
- **Fixed**: the provenance gate silently under-scanned on POSIX — `execSync`
  let the shell expand `apps/**/*.ts` before git saw it, and any pattern with a
  shallow match collapsed to just those files, dropping the deep tree from the
  scan. Windows `cmd` (which does not glob) scanned everything and exposed 12
  uncited decision sites the POSIX runs had been missing. The gate now uses
  `execFileSync` (no shell, identical on every platform) and the template
  carries citations at all 12 sites.
- **Fixed**: `.github/actionlint.yaml` ships with the template (and is staged
  in the harness's own lint fixture) declaring the `gpu` self-hosted runner
  label used by the eval-live module — actionlint no longer fails on it.
- **Fixed**: plugin manifest `agents` now lists the eight agent files
  explicitly (the validator rejects a bare directory path for `agents`);
  marketplace manifest gained a `metadata.description`. `claude plugin
  validate` passes clean.
- **Fixed**: Windows path separators in the prompts and contracts gates —
  `join()`/`relative()` output was compared against POSIX lock keys and
  tsconfig reference paths, so every prompt read as "not in the lock" and
  every project reference as missing. Both normalize to POSIX at the
  comparison boundary now.
- **Fixed**: the bindings-export sub-check of `rust-check` skips loudly on
  Windows when the test executable dies at load with
  `STATUS_ENTRYPOINT_NOT_FOUND` (the test binary links the full
  tauri/wry/WebView2 runtime without an embedded app manifest — a loader
  quirk, not a bindings problem). `cargo check --locked` still runs, and
  drift stays fail-closed on Linux CI for every PR.

## [0.1.0] — 2026-07-10

Initial release.

- **Installer**: `init` (bootstrap + retrofit with merge-never-clobber semantics,
  pnpm-workspace glob-union merge, Buffer-safe binary assets), `update`, `doctor`
  (raw-byte manifest hashing, hook version stamps, `@AGENTS.md` include check),
  `enable`/`disable` for 12 opt-in modules across core/standard/strict tiers.
- **Enforcement**: 5 fail-closed Claude Code hooks (bash guard, write guard with
  append-only migrations + Tauri surface content checks + GUC discipline, provenance
  check, single-file format feedback, Stop validate-gate), 43 contract tests.
- **Gate chain**: 16 config-driven steps mirrored by a hardcoded CI floor —
  biome, rustfmt, `tsc -b`, strictTypeChecked eslint, provenance, tauri-policy,
  version-sync, prompt locks, license allowlist, schema-RLS manifest, migration
  discipline, contract drift, knip strict, dependency-cruiser, vite build with
  bundle-purity grep, stamped `cargo check` + specta bindings drift.
- **Runtime proof**: plain-Postgres RLS isolation suite with seeded positive
  controls, SQLSTATE 42501 asserts, GUC-leak detector, pg_catalog gate; fresh-apply
  migration runner; `rls_verify` + `corpus_search` MCP servers.
- **Reference stack**: Tauri 2 (isolation pattern, offline WebView2, committed
  specta bindings, keyboard registry with WCAG 2.1.4 test, OKLCH tokens), Hono
  server (Entra/stub auth with production-fatal stub, version-skew middleware,
  SSE with abort propagation, server-only DAL), Drizzle schema + pgvector,
  zero-dep importer with fast-check, fixture-scored eval package.
- **CI**: selftest matrix (bootstrap ubuntu + windows-every-PR, canary
  inject-and-fail per gate, retrofit non-clobber, nightly Windows `tauri build`
  with silent-install smoke), shipped template workflows (quality-gate with Rust +
  RLS + Playwright mock-IPC lanes, migration-safety, api-contract, adr-guard,
  CodeQL, osv over both lockfiles, gitleaks, actionlint + zizmor), all SHA-pinned.
- Verified: 16/16 gates + full Stop chain green on a from-scratch scaffold
  (warm validate ≈ 7s); 69/69 harness self-tests.
