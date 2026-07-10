// Placeholder registry. Every {{TOKEN}} used anywhere under template/ MUST be
// declared here (scripts/hygiene.mjs enforces closure in both directions).
// Declaration order is prompt order — identity first, deployment last.
// NOTE: Entra tenant/client IDs are deliberately NOT placeholders — they are
// per-environment deployment config and live in .env (see env.example).
// Baking placeholder GUIDs into committed files invites real IDs into git.
export const PLACEHOLDERS = {
  PROJECT_NAME: {
    prompt: 'Human-readable project name (e.g. "Acme Curriculum")',
    default: (ctx) => ctx.dirName ?? 'My Project',
  },
  PROJECT_SLUG: {
    prompt: 'Package/machine name (kebab-case)',
    default: (ctx) =>
      (ctx.answers.PROJECT_NAME ?? ctx.dirName ?? 'my-project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
  },
  // Windows/Tauri bundle identifier. NSIS + MSI upgrade identity derive from
  // it; ≤30 chars keeps it inside the MSI UpgradeCode derivation limit and it
  // must never change after first release (tools/identity.lock.json pins it).
  PRODUCT_IDENTIFIER: {
    prompt: 'Reverse-DNS bundle identifier (e.g. com.acme.curriculum, ≤30 chars, immutable after release)',
    default: (ctx) => {
      const slug = (ctx.answers.PROJECT_SLUG ?? ctx.dirName ?? 'my-project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
      return `com.example.${slug}`.slice(0, 30)
    },
  },
  WINDOWS_PUBLISHER: {
    prompt: 'Windows publisher display name (installer + Add/Remove Programs)',
    default: (ctx) => ctx.answers.PROJECT_NAME ?? ctx.dirName ?? 'My Company',
  },
  // The server origin the desktop client talks to. Feeds the COMMITTED CSP in
  // tauri.conf.json (connect-src) — which is why it is a placeholder, not env.
  API_ORIGIN: {
    prompt: 'API origin the desktop client connects to (e.g. https://api.internal.example.edu)',
    default: () => 'http://127.0.0.1:8787',
  },
  DB_NAME: {
    prompt: 'Postgres database name',
    default: (ctx) =>
      (ctx.answers.PROJECT_SLUG ?? ctx.dirName ?? 'app').replace(/-/g, '_'),
  },
  GITHUB_OWNER: {
    prompt: 'GitHub org/user that owns the repo',
    default: (ctx) => ctx.gitOwner ?? 'your-github-owner',
  },
  SECURITY_OWNERS: {
    prompt: 'GitHub handle/team for auth+data sign-off (CODEOWNERS)',
    default: (ctx) => `@${ctx.answers.GITHUB_OWNER ?? ctx.gitOwner ?? 'your-github-owner'}`,
  },
  DEFAULT_BRANCH: {
    prompt: 'Default git branch',
    default: () => 'main',
  },
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g

export function render(text, answers) {
  return text.replace(TOKEN_RE, (whole, name) => {
    if (name in answers) return answers[name]
    return whole // unknown tokens are left intact and flagged by doctor/hygiene
  })
}

export function tokensIn(text) {
  const found = new Set()
  for (const m of text.matchAll(TOKEN_RE)) found.add(m[1])
  return found
}
