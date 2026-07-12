// Guard rule tables — PURE DATA for the PreToolUse guards (pretool-bash-guard.mjs,
// pretool-write-guard.mjs). No imports, no side effects, no top-level env/fs reads: the
// guards dynamic-import this AFTER hookio's fail-closed handlers are active, and if it
// cannot load or is mis-shaped they BLOCK (a guard that cannot read its rules must approve
// nothing). Keeping the rules here — importable in-process by tests — turns falsifiability
// from a brittle count into a per-rule behavioral closure: every id below must have at
// least one deny/allow canary in tests/hooks/hook-contract.test.mjs (checked by
// scripts/check-canary-coverage.mjs). Regexes/conditions are byte-equivalent ports of the
// former inline rule tables — do not weaken them.
// SOURCE: docs/harness/README.md (tamper evidence; hooks fail closed)

// ── bash-guard: shell-write enforcement surface ──────────────────────────────
// A shell redirect writes the same bytes ungated: `echo x > tools/validate.mjs` or
// `echo <hash> > .harness/build.ok` (stamp forgery) would bypass every write-guard content
// check and per-edit provenance. Deny shell WRITES whose target sits on the surface.
// [\\/] everywhere a separator appears: on Windows shells the same write is spelled
// `tools\validate.mjs`, and a `/`-only pattern would fail OPEN there.
const PROT_DIRS = String.raw`(?:\.[\\/])?(?:tools|\.claude|\.harness|\.github[\\/]workflows|packages[\\/]schema[\\/]drizzle|tests[\\/]rls|tests[\\/]migrations)[\\/][^\s"'|;&]*`
const PROT_FILES = String.raw`(?:\.[\\/])?(?:pnpm-lock\.yaml|Cargo\.lock|lefthook\.yml|biome\.jsonc|knip\.json|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|commitlint\.config\.mjs|\.dependency-cruiser\.cjs|pnpm-workspace\.yaml|deny\.toml|rust-toolchain\.toml|\.gitleaks\.toml|\.mcp\.json)\b`
const PROT = `(?:${PROT_DIRS}|${PROT_FILES})`

const SHELL_WRITE_MSG =
  'Blocked: shell writes to the enforcement surface (gate scripts, hooks, stamps, lockfiles, migrations, workflows) bypass the write-guard — edit via the Write tool with HARNESS_ALLOW_SELF_EDIT=1 (human-in-the-loop).'

// Four spellings of a write whose destination is the protected surface.
const SHELL_WRITE_RES = [
  // shell redirection: `> path` / `>> path`
  new RegExp(`(?:^|[^<>])>{1,2}\\s*(?:"|')?${PROT}`),
  // tee (with any flags)
  new RegExp(String.raw`\btee\s+(?:-[a-zA-Z]+\s+)*(?:"|')?${PROT}`),
  // in-place edit via sed/perl -i
  new RegExp(String.raw`\b(?:sed|perl)\b[^|;&]*\s-i\b[^|;&]*${PROT}`),
  // cp/mv/etc with a protected path as the DESTINATION (final argument). Reading
  // FROM the surface (`cp tools/x.mjs /tmp/`) stays allowed.
  new RegExp(String.raw`\b(?:cp|mv|rsync|install|ln)\b[^|;&]*\s(?:"|')?${PROT}(?:"|')?\s*(?:$|[|;&])`),
]

// The sanctioned uses of the RLS-bypassing migrator DSN: drizzle-kit migrate/generate/check
// and the harness RLS runners (tests/migrations fresh-apply; tests/rls orchestrator).
const MIGRATOR_SANCTIONED =
  /drizzle-kit\s+(migrate|generate|check)|db:migrate|test:rls|tests[\\/](migrations|rls)[\\/]/

// Each rule: { id, re | test(cmd), message, allowWhen?(cmd, ctx) }. The guard denies on the
// FIRST matching rule (array order = message priority) unless allowWhen suppresses it. ctx
// carries { selfEdit } (HARNESS_ALLOW_SELF_EDIT=1). No env is read here — the guard reads it.
export const BASH_RULES = [
  {
    id: 'rm-rf',
    // Both a recursive and a force flag anywhere in the same command segment:
    // covers -rf, -fr, -Rf, split `-r -f`, and the long/reversed spellings.
    re: /\brm(?=\s)(?=[^|;&]*\s-(?:[a-zA-Z]*[rR][a-zA-Z]*\b|-recursive\b))(?=[^|;&]*\s-(?:[a-zA-Z]*[fF][a-zA-Z]*\b|-force\b))/,
    message: "Blocked: 'rm -rf' (any flag spelling) is forbidden by the harness.",
  },
  {
    id: 'shell-write-protected',
    test: (cmd) => SHELL_WRITE_RES.some((re) => re.test(cmd)),
    message: SHELL_WRITE_MSG,
    // Honors the same HARNESS_ALLOW_SELF_EDIT=1 human escape hatch as the write-guard.
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'git-hookspath-repoint',
    re: /git\s+(?:-[a-zA-Z]+\s+)*config\b[^|;&]*core\.hooksPath|git\s+-c\s*core\.hooksPath/,
    message: 'Blocked: repointing core.hooksPath disables the lefthook commit-time layer.',
  },
  {
    // .dev-auth holds the dev JWKS + minted tokens; no shell command has a
    // legitimate reason to reference it.
    id: 'dev-auth-access',
    re: /\.dev-auth\//,
    message:
      'Blocked: .dev-auth/ holds local signing material — it is never read, copied, or listed from shell.',
  },
  {
    id: 'git-force-push',
    re: /git\s+push\s+(--force|-f|--force-with-lease)\b/,
    message: 'Blocked: force-push is forbidden; rewrite history via PR review only.',
  },
  {
    id: 'git-reset-hard',
    re: /git\s+reset\s+--hard\b/,
    message: "Blocked: 'git reset --hard' destroys uncommitted work.",
  },
  {
    id: 'git-commit-no-verify',
    re: /git\s+commit\s[^|;&]*(--no-verify|\s-n\b)/,
    message:
      'Blocked: bypassing commit hooks (--no-verify) defeats the gate; fix the failure instead.',
  },
  {
    id: 'fork-bomb',
    re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
    message: 'Blocked: fork bomb pattern.',
  },
  {
    // Real secret files only — .env, .env.local, .env.production … but NOT the committed,
    // secret-free .env.example / .env.sample / .env.template that document required vars.
    id: 'read-env-file',
    re: /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd)\s+[^|;&]*\.env(?!\.(example|sample|template)\b)(\.|\b)/,
    message: 'Blocked: reading .env files is forbidden; secrets are injected at runtime.',
  },
  {
    // `source .env` / `. .env` loads secrets into the shell environment.
    id: 'source-env-file',
    re: /(?:^|[|;&]\s*)(?:source|\.)\s+[^|;&]*\.env\b(?!\.(example|sample|template)\b)/,
    message: 'Blocked: sourcing .env files is forbidden; secrets are injected at runtime.',
  },
  {
    id: 'drizzle-kit-push',
    re: /\bdrizzle-kit\s+push\b/,
    message:
      'Blocked: `drizzle-kit push` bypasses migration files. Generate a migration (drizzle-kit generate) and apply it (db:migrate) so the change is reviewed and reproducible.',
  },
  {
    id: 'drizzle-kit-drop',
    re: /\bdrizzle-kit\s+drop\b/,
    message: 'Blocked: `drizzle-kit drop` deletes migration history — migrations are append-only.',
  },
  {
    id: 'knip-fix',
    re: /\bknip\b[^|;&]*--fix\b/,
    message:
      'Blocked: `knip --fix` auto-deletes code and has false positives; remove dead code by hand after reviewing the report.',
  },
  {
    id: 'dependency-update',
    re: /\b(pnpm|cargo)\s+update\b/,
    message:
      'Blocked: bulk dependency updates are Renovate-owned (pinned, cooled-down, reviewed). Change one pin deliberately if needed.',
  },
  {
    // The privileged migrator DSN bypasses RLS (table owner). Sanctioned uses only.
    id: 'migrator-dsn',
    re: /MIGRATOR_DATABASE_URL/,
    allowWhen: (cmd) => MIGRATOR_SANCTIONED.test(cmd),
    message:
      'Blocked: MIGRATOR_DATABASE_URL is the RLS-bypassing role — only drizzle-kit migrate/generate/check and the tests/migrations + tests/rls runners may use it.',
  },
  {
    id: 'destructive-sql',
    re: /\b(psql|pg_restore)\b[^|;&]*\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i,
    message: 'Blocked: destructive SQL must go through a reviewed, ADR-coupled migration.',
  },
  {
    id: 'tauri-signing-key',
    re: /TAURI_SIGNING_PRIVATE_KEY\s*=|\becho\s+[^|;&]*TAURI_SIGNING_PRIVATE_KEY/,
    message:
      'Blocked: the updater signing key must never be set or echoed in shell — CI injects it from secrets.',
  },
  {
    id: 'minisign-secret-key',
    re: /\b(cat|less|more|head|tail|grep|xxd|strings|cp|mv)\s+[^|;&]*\.key\b[^|;&]*minisign|minisign\s+-[A-Za-z]*s/,
    message: 'Blocked: minisign secret-key material must never be read or generated into the repo.',
  },
]

// ── write-guard: harness-protected paths (tamper evidence, layer 2) ──────────
// Root-anchored (^…) against the POSIX-normalized project-relative path. Weakening any of
// these weakens the gate; edits require HARNESS_ALLOW_SELF_EDIT=1 (checked by the guard).
export const WRITE_PROTECTED = [
  { id: 'harness-config', re: /^tools\/harness\.config\.mjs$/ },
  { id: 'validate-runner', re: /^tools\/validate\.mjs$/ },
  // The frozen CI floor: `validate.mjs --min-floor` trusts THIS file over the config, so a
  // shell/tool edit here would be the way to weaken CI without touching the config.
  { id: 'validate-floor', re: /^tools\/validate\.floor\.json$/ },
  // perf-baseline.mjs is the ratchet-baseline regenerator — same trust level as
  // the gate that consumes its output.
  { id: 'gate-scripts', re: /^tools\/(check-[^/]+|run-rust-gates|build-check|perf-baseline)\.mjs$/ },
  // The bare-URL citation allowlist the provenance gate resolves against — widening it
  // weakens the gate, so adding a domain is a human decision. Listed BEFORE tools-lib
  // (which also covers the path) so the deny carries its own named, canaried rule id.
  { id: 'citation-domains', re: /^tools\/lib\/citation-domains\.mjs$/ },
  { id: 'tools-lib', re: /^tools\/lib\// }, // shared gate helpers — same trust level as the gates
  { id: 'tools-mcp', re: /^tools\/mcp\// }, // corpus + MCP servers the provenance gate resolves against
  { id: 'lock-json', re: /^tools\/(identity|prompts)\.lock\.json$/ },
  { id: 'rls-exempt', re: /^tools\/rls-exempt\.json$/ }, // exempting a table from RLS is a human decision
  { id: 'provenance-overrides', re: /^tools\/provenance-overrides\.json$/ }, // cross-group citation escapes are a human decision
  { id: 'license-exceptions', re: /^tools\/license-exceptions\.json$/ }, // license exceptions are a human decision
  { id: 'bundle-budget', re: /^tools\/bundle-budget\.json$/ },
  // The committed gzip-ratchet baseline: regenerated ONLY by `pnpm perf:baseline`
  // in a reviewed commit — an agent editing it would re-baseline its own regression.
  { id: 'perf-baseline', re: /^tools\/perf-baseline\.json$/ },
  { id: 'perf-budget', re: /^tools\/perf-budget\.json$/ },
  // Wall-clock budgets for the CI-only interaction-latency lane — raising one
  // re-baselines the agent's own UX regression, so the edit is human-only.
  { id: 'interaction-budget', re: /^tools\/interaction-budget\.json$/ },
  { id: 'styleguide-manifest', re: /^tools\/styleguide\.manifest\.json$/ },
  { id: 'mutation-baseline', re: /^tools\/mutation-baseline\.json$/ }, // accepting a surviving mutant is a human decision
  { id: 'route-allowlist', re: /^tools\/route-allowlist\.json$/ }, // exempting a features dir from ROUTES is a human decision
  { id: 'rls-runner', re: /^tests\/rls\/run-rls\.mjs$/ }, // the RLS runner the Stop hook invokes directly
  { id: 'migration-apply-runner', re: /^tests\/migrations\/migration-apply\.mjs$/ },
  { id: 'lefthook', re: /^lefthook\.yml$/ },
  { id: 'github-workflows', re: /^\.github\/workflows\// },
  // The lint/architecture config surface — weakening any of these weakens the gate.
  { id: 'eslint-config', re: /^eslint\.config\.mjs$/ },
  { id: 'biome-config', re: /^biome\.jsonc$/ },
  { id: 'knip-config', re: /^knip\.json$/ },
  { id: 'dependency-cruiser', re: /^\.dependency-cruiser\.cjs$/ },
  { id: 'vitest-config', re: /^vitest\.config\.ts$/ }, // the single test-project surface the Stop hook runs
  { id: 'playwright-config', re: /^playwright\.config\.ts$/ },
  { id: 'tsconfig', re: /^tsconfig(\.base)?\.json$/ },
  { id: 'pnpm-workspace', re: /^pnpm-workspace\.yaml$/ },
  { id: 'deny-toml', re: /^deny\.toml$/ }, // cargo-deny policy (licenses + advisories + bans)
  { id: 'rust-toolchain', re: /^rust-toolchain\.toml$/ },
  { id: 'gitleaks-config', re: /^\.gitleaks\.toml$/ },
  // Permission + MCP surface: never let the agent widen its own grants or add MCP servers.
  { id: 'claude-settings', re: /^\.claude\/settings\.json$/ },
  { id: 'claude-settings-local', re: /^\.claude\/settings\.local\.json$/ },
  { id: 'mcp-json', re: /^\.mcp\.json$/ },
  { id: 'harness-dir', re: /^\.harness\// },
]

// ── write-guard: everywhere-checks (banned CONTENT in any source file) ───────
export const WRITE_GLOBAL_CHECKS = [
  {
    id: 'dangerously-set-inner-html',
    re: /\bdangerouslySetInnerHTML\b/,
    message:
      'dangerouslySetInnerHTML is banned (XSS); render sanitized text through approved components.',
  },
  {
    id: 'vite-secret-name',
    re: /VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/,
    message:
      'VITE_-prefixed vars are compiled into the client bundle — never put secret-shaped names there.',
  },
  {
    // Lazy [\s\S]*? instead of [^,]+ so a comma INSIDE the value expression
    // cannot hide the session-wide third argument; /i catches SQL-style FALSE.
    id: 'set-config-session-wide',
    re: /set_config\(\s*['"]app\.[a-z_.]+['"]\s*,[\s\S]*?,\s*false\s*\)/i,
    message:
      'set_config(..., false) sets the GUC session-wide and LEAKS across pooled connections — the third argument must be true (transaction-local). SOURCE: docs/harness/README.md (GUC discipline)',
  },
  {
    id: 'set-session-app-guc',
    re: /\bSET\s+SESSION\s+app\.|\bSET\s+app\./i,
    message:
      'RLS identity GUCs must be SET LOCAL inside a transaction, never session-wide (pooling leak).',
  },
  {
    id: 'vitest-workspace-file',
    re: /defineWorkspace|vitest\.workspace/,
    message:
      'vitest workspace files are banned — projects are defined in the root vitest.config.ts (single gate surface).',
  },
]
