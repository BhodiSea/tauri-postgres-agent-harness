#!/usr/bin/env node
// PreToolUse / matcher: Bash — deterministic block of dangerous shell + secret leaks.
// A high-value tripwire, NOT a complete sandbox: obfuscated commands can evade
// substring checks. The settings.json deny list + permission model are the primary
// control; ESLint + the write-guard enforce the same invariants in source.
// SOURCE: docs/harness/README.md (pretool-bash-guard)
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.1'

const input = await readHookInput()
const cmd = String(input?.tool_input?.command ?? '')

const RULES = [
  [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force)\b/,
    "Blocked: 'rm -rf' is forbidden by the harness.",
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
    /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings)\s+[^|;&]*\.env(?!\.(example|sample|template)\b)(\.|\b)/,
    'Blocked: reading .env files is forbidden; secrets are injected at runtime.',
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
    // migration test runner.
    /MIGRATOR_DATABASE_URL/,
    /drizzle-kit\s+(migrate|generate|check)|db:migrate|tests\/migrations\//.test(cmd)
      ? null
      : 'Blocked: MIGRATOR_DATABASE_URL is the RLS-bypassing role — only drizzle-kit migrate/generate/check and tests/migrations may use it.',
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
