#!/usr/bin/env node
// PreToolUse / matcher: Bash — deterministic block of dangerous shell + secret leaks.
// A high-value tripwire, NOT a complete sandbox: obfuscated commands can evade
// substring checks. The settings.json deny list + permission model are the primary
// control; ESLint + the write-guard enforce the same invariants in source.
// SOURCE: docs/harness/README.md (pretool-bash-guard)
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.3'

const input = await readHookInput()
const cmd = String(input?.tool_input?.command ?? '')

// The write-guard content-checks Edit/Write, but a shell redirect writes the same
// bytes ungated: `echo x > tools/validate.mjs` or `echo <hash> > .harness/build.ok`
// (stamp forgery) would bypass every content check and per-edit provenance. Deny
// shell WRITES whose target sits on the enforcement surface. Honors the same
// HARNESS_ALLOW_SELF_EDIT=1 human escape hatch as the write-guard (canary CI
// injections use it deliberately).
// SOURCE: docs/harness/README.md (tamper evidence)
const PROT_DIRS = String.raw`(?:\.\/)?(?:tools|\.claude|\.harness|\.github\/workflows|packages\/schema\/drizzle|tests\/rls|tests\/migrations)\/[^\s"'|;&]*`
const PROT_FILES = String.raw`(?:\.\/)?(?:pnpm-lock\.yaml|Cargo\.lock|lefthook\.yml|biome\.jsonc|knip\.json|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|commitlint\.config\.mjs|\.dependency-cruiser\.cjs|pnpm-workspace\.yaml|deny\.toml|rust-toolchain\.toml|\.gitleaks\.toml|\.mcp\.json)\b`
const PROT = `(?:${PROT_DIRS}|${PROT_FILES})`
const selfEdit = process.env.HARNESS_ALLOW_SELF_EDIT === '1'
const SHELL_WRITE_MSG =
  'Blocked: shell writes to the enforcement surface (gate scripts, hooks, stamps, lockfiles, migrations, workflows) bypass the write-guard — edit via the Write tool with HARNESS_ALLOW_SELF_EDIT=1 (human-in-the-loop).'

const RULES = [
  [
    // Both a recursive and a force flag anywhere in the same command segment:
    // covers -rf, -fr, -Rf, split `-r -f`, and the long/reversed spellings the
    // old single-token regex missed.
    /\brm(?=\s)(?=[^|;&]*\s-(?:[a-zA-Z]*[rR][a-zA-Z]*\b|-recursive\b))(?=[^|;&]*\s-(?:[a-zA-Z]*[fF][a-zA-Z]*\b|-force\b))/,
    "Blocked: 'rm -rf' (any flag spelling) is forbidden by the harness.",
  ],
  [
    new RegExp(`(?:^|[^<>])>{1,2}\\s*(?:"|')?${PROT}`),
    selfEdit ? null : SHELL_WRITE_MSG,
  ],
  [
    new RegExp(String.raw`\btee\s+(?:-[a-zA-Z]+\s+)*(?:"|')?${PROT}`),
    selfEdit ? null : SHELL_WRITE_MSG,
  ],
  [
    new RegExp(String.raw`\b(?:sed|perl)\b[^|;&]*\s-i\b[^|;&]*${PROT}`),
    selfEdit ? null : SHELL_WRITE_MSG,
  ],
  [
    // cp/mv/etc with a protected path as the DESTINATION (final argument).
    // Reading FROM the surface (`cp tools/x.mjs /tmp/`) stays allowed.
    new RegExp(String.raw`\b(?:cp|mv|rsync|install|ln)\b[^|;&]*\s(?:"|')?${PROT}(?:"|')?\s*(?:$|[|;&])`),
    selfEdit ? null : SHELL_WRITE_MSG,
  ],
  [
    /git\s+(?:-[a-zA-Z]+\s+)*config\b[^|;&]*core\.hooksPath|git\s+-c\s*core\.hooksPath/,
    'Blocked: repointing core.hooksPath disables the lefthook commit-time layer.',
  ],
  [
    // .dev-auth holds the dev JWKS + minted tokens; no shell command has a
    // legitimate reason to reference it (mint-dev-token.mjs writes it without
    // naming it). AGENTS.md documents this surface as guard-enforced.
    /\.dev-auth\//,
    'Blocked: .dev-auth/ holds local signing material — it is never read, copied, or listed from shell.',
  ],
  [
    /git\s+push\s+(--force|-f|--force-with-lease)\b/,
    'Blocked: force-push is forbidden; rewrite history via PR review only.',
  ],
  [/git\s+reset\s+--hard\b/, "Blocked: 'git reset --hard' destroys uncommitted work."],
  [
    /git\s+commit\s[^|;&]*(--no-verify|\s-n\b)/,
    'Blocked: bypassing commit hooks (--no-verify) defeats the gate; fix the failure instead.',
  ],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, 'Blocked: fork bomb pattern.'],
  [
    // Real secret files only — .env, .env.local, .env.production … but NOT the committed,
    // secret-free .env.example / .env.sample / .env.template that document required vars.
    /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd)\s+[^|;&]*\.env(?!\.(example|sample|template)\b)(\.|\b)/,
    'Blocked: reading .env files is forbidden; secrets are injected at runtime.',
  ],
  [
    // `source .env` / `. .env` loads secrets into the shell environment —
    // the reader-command list above cannot see this spelling.
    /(?:^|[|;&]\s*)(?:source|\.)\s+[^|;&]*\.env\b(?!\.(example|sample|template)\b)/,
    'Blocked: sourcing .env files is forbidden; secrets are injected at runtime.',
  ],
  [
    /\bdrizzle-kit\s+push\b/,
    'Blocked: `drizzle-kit push` bypasses migration files. Generate a migration (drizzle-kit generate) and apply it (db:migrate) so the change is reviewed and reproducible.',
  ],
  [
    /\bdrizzle-kit\s+drop\b/,
    'Blocked: `drizzle-kit drop` deletes migration history — migrations are append-only.',
  ],
  [
    /\bknip\b[^|;&]*--fix\b/,
    'Blocked: `knip --fix` auto-deletes code and has false positives; remove dead code by hand after reviewing the report.',
  ],
  [
    /\b(pnpm|cargo)\s+update\b/,
    'Blocked: bulk dependency updates are Renovate-owned (pinned, cooled-down, reviewed). Change one pin deliberately if needed.',
  ],
  [
    // The privileged migrator DSN is this stack's service-role analog: it bypasses RLS
    // (table owner). Sanctioned uses only: drizzle-kit migrate/generate/check and the
    // harness RLS runners (tests/migrations/ fresh-apply; tests/rls/ orchestrator —
    // its plan probe seeds and ANALYZEs through the owner role). The runners' own
    // fix hints say to set this env var, so pointing them at a database stays legal.
    /MIGRATOR_DATABASE_URL/,
    /drizzle-kit\s+(migrate|generate|check)|db:migrate|test:rls|tests\/(migrations|rls)\//.test(cmd)
      ? null
      : 'Blocked: MIGRATOR_DATABASE_URL is the RLS-bypassing role — only drizzle-kit migrate/generate/check and the tests/migrations + tests/rls runners may use it.',
  ],
  [
    /\b(psql|pg_restore)\b[^|;&]*\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i,
    'Blocked: destructive SQL must go through a reviewed, ADR-coupled migration.',
  ],
  [
    /TAURI_SIGNING_PRIVATE_KEY\s*=|\becho\s+[^|;&]*TAURI_SIGNING_PRIVATE_KEY/,
    'Blocked: the updater signing key must never be set or echoed in shell — CI injects it from secrets.',
  ],
  [
    /\b(cat|less|more|head|tail|grep|xxd|strings|cp|mv)\s+[^|;&]*\.key\b[^|;&]*minisign|minisign\s+-[A-Za-z]*s/,
    'Blocked: minisign secret-key material must never be read or generated into the repo.',
  ],
]

if (cmd) {
  for (const [re, msg] of RULES) {
    if (msg && re.test(cmd)) denyTool('PreToolUse', msg)
  }
}
pass()
