// Shared layout constants for the installer.
// Template storage conventions: files that install to dot-paths are stored
// dotless (npm-packlist strips .gitignore/.npmrc and treats nested .gitignore
// as pack-ignore manifests; storing .github dotless also prevents template
// workflows from executing in this repo's own Actions). `.claude/` is the one
// dotted exception: verified to survive npm pack, and hooks reference it.
export const RENAMES = new Map([
  ['gitignore', '.gitignore'],
  ['github', '.github'],
  ['gitattributes', '.gitattributes'],
  ['editorconfig', '.editorconfig'],
  ['nvmrc', '.nvmrc'],
  ['node-version', '.node-version'],
  ['gitleaks.toml', '.gitleaks.toml'],
  ['dependency-cruiser.cjs', '.dependency-cruiser.cjs'],
  ['mcp.json', '.mcp.json'],
  ['env.example', '.env.example'],
])

// Opt-in modules under template/modules/<name>/ (same storage conventions).
export const MODULES = [
  'ci-windows-release',
  'ci-windows-e2e',
  'ci-macos',
  'ci-provenance',
  'mutation',
  'gate-a11y-deep',
  'crash-reporting',
  'ops-backup',
  'eval-live',
  'observability',
]

// Modules folded into the default harness by a release (template/migrations.json
// promotedModules). `enable` refuses these with the promotion story instead of a
// bare "unknown module".
export const RETIRED_MODULES = new Map([
  ['gate-styleguide', 'promoted into the default gate chain in the 0.1.3 release — run `update`; the styleguide gate now ships in tools/ by default'],
  ['gate-perf-budget', 'promoted into the default gate chain in the 0.1.3 release — run `update`; the perf-budget gate now ships in tools/ by default'],
])

export const TIERS = {
  core: [],
  standard: ['ci-provenance', 'ci-windows-release'],
  strict: [...MODULES],
}

// Installed paths written once and never overwritten by `update` (the project
// owns them after init). Matched by prefix or exact path.
export const SEEDED_PREFIXES = [
  'apps/',
  'packages/',
  'drizzle/',
  'tests/unit/',
]
export const SEEDED_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'CITATION.cff',
  'SECURITY.md',
  '.env.example',
  '.gitignore',
  'package.json',
  'pnpm-workspace.yaml',
  'rust-toolchain.toml',
  'deny.toml',
  'docker-compose.yml',
  'tools/aliveness-manifest.mjs',
  'tools/rls-exempt.json',
  'tools/provenance-overrides.json', // reviewed cross-group cites — consumer-owned like rls-exempt
  'tools/license-exceptions.json',
  'tools/identity.lock.json',
  'tools/prompts.lock.json',
  // Human-tuned budget/design data: write-guard-protected against agents, but a
  // project raises them deliberately — update must plant-when-absent, never clobber.
  'tools/styleguide.manifest.json',
  'tools/perf-budget.json',
  'tools/bundle-budget.json',
  'tools/route-allowlist.json',
  'tests/rls/db-context.ts',
])

// The gate config is seeded (projects tune it) but hash-tracked so `doctor`
// can surface drift. SOURCE: docs/harness/README.md (tamper evidence)
export const CONFIG_FILES = new Set(['tools/harness.config.mjs'])

// Stack files installed in retrofit mode only when absent (additive seeds).
// Workspace packages are additive-only: never merged into existing apps.
export const RETROFIT_ADDITIVE = new Set([
  'packages/schema/package.json',
  'packages/importer/package.json',
  'packages/eval/package.json',
])

// Existing root configs the installer must never clobber on retrofit: if the
// project already has one, ours lands alongside as <base>.harness.<ext>.
// pnpm-workspace.yaml is the exception — it is MERGED (glob union, catalog
// add-missing/never-downgrade) by merge-workspace-yaml.mjs, not suffixed.
export const CONFLICTABLE = [
  { installed: 'eslint.config.mjs', existing: /^eslint\.config\.(js|mjs|cjs|ts|mts)$/ },
  { installed: 'biome.jsonc', existing: /^biome\.jsonc?$/ },
  { installed: 'tsconfig.json', existing: /^tsconfig\.json$/ },
  { installed: 'knip.json', existing: /^knip\.(json|jsonc|ts)$/ },
  { installed: '.dependency-cruiser.cjs', existing: /^\.dependency-cruiser\.(js|cjs|mjs)$/ },
  { installed: 'lefthook.yml', existing: /^lefthook\.(yml|yaml)$/ },
  { installed: 'commitlint.config.mjs', existing: /^commitlint\.config\.(js|mjs|cjs|ts)$/ },
  { installed: 'vitest.config.ts', existing: /^vitest\.config\.(ts|mts|js|mjs)$/ },
  { installed: 'playwright.config.ts', existing: /^playwright\.config\.(ts|mts|js|mjs)$/ },
  { installed: 'cspell.json', existing: /^\.?cspell\.(json|jsonc|yaml|yml)$/ },
  { installed: '.gitleaks.toml', existing: /^\.gitleaks\.toml$/ },
  { installed: '.mcp.json', existing: /^\.mcp\.json$/ },
  { installed: 'deny.toml', existing: /^deny\.toml$/ },
  { installed: 'rust-toolchain.toml', existing: /^rust-toolchain(\.toml)?$/ },
]
