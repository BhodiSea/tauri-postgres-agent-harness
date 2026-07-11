// .dependency-cruiser.cjs (stored dotless; the installer renames it) — the architecture
// law from BUILD-SPEC §depcruise, run as `depcruise apps packages --config .dependency-cruiser.cjs`.
// Path regexes match RESOLVED paths, so `node_modules/<pkg>/` also matches pnpm's
// `.pnpm/<pkg>@<v>/node_modules/<pkg>/` store layout.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Dependency cycles make builds, tests, and reasoning order-dependent.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'desktop-not-into-server',
      comment:
        'The SPA talks to the API over HTTP only. Importing server code would smuggle ' +
        'server-only modules (and their secrets/config assumptions) into the webview bundle.',
      severity: 'error',
      from: { path: '^apps/desktop' },
      to: { path: '^apps/server' },
    },
    {
      name: 'desktop-no-server-stack',
      comment:
        'DB driver, ORM, logger, and HTTP framework are server-side; if the desktop bundle ' +
        'can resolve them, the client/server boundary has already been breached.',
      severity: 'error',
      from: { path: '^apps/desktop' },
      to: { path: 'node_modules/(postgres|drizzle-orm|pino|@hono)/' },
    },
    {
      name: 'drizzle-orm-schema-and-server-only',
      comment:
        'drizzle-orm is allowed in packages/schema (table defs) and apps/server (queries via ' +
        'the DAL). Anywhere else means database access is leaking out of the DAL boundary.',
      severity: 'error',
      from: { pathNot: '^(packages/schema|apps/server)' },
      to: { path: 'node_modules/drizzle-orm/' },
    },
    {
      name: 'drizzle-zod-schema-only',
      comment:
        'drizzle-zod derives DTO schemas from tables; only packages/schema may do that — ' +
        'consumers import the derived Zod DTOs, never the derivation.',
      severity: 'error',
      from: { pathNot: '^packages/schema' },
      to: { path: 'node_modules/drizzle-zod/' },
    },
    {
      name: 'postgres-driver-db-layer-only',
      comment:
        'The postgres driver is the DAL substrate: only apps/server/src/db/** may import it. ' +
        'Routes and DAL modules reach the database exclusively through withUserContext ' +
        '(src/db/context.ts), where the transaction binds the RLS identity — a stray driver ' +
        'import is an unauthorized path around FORCE RLS.',
      severity: 'error',
      from: { pathNot: '^apps/server/src/db/' },
      to: { path: 'node_modules/postgres/' },
    },
    {
      name: 'db-context-dal-only',
      comment:
        'withUserContext (apps/server/src/db/context*) is THE authorization boundary; only the ' +
        'DAL layer (src/dal/**, including its colocated tests) and db internals may import it. ' +
        'Routes depend on the NotesDal port — a route importing the context could run queries ' +
        'outside the DAL law (Zod-parse at exit, no raw rows).',
      severity: 'error',
      from: { path: '^apps/server', pathNot: '^apps/server/src/(dal|db)/' },
      to: { path: '^apps/server/src/db/context' },
    },
    {
      name: 'llm-sdks-eval-adapters-only',
      comment:
        'LLM SDKs may only be touched by packages/eval/src/adapters — every other module ' +
        'programs against the InferenceProvider/EmbeddingProvider ports (no live-model creep).',
      severity: 'error',
      from: { pathNot: '^packages/eval/src/adapters' },
      to: { path: 'node_modules/(openai|@anthropic-ai|ollama)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: ['\\.d\\.ts$', '(^|/)dist/', '(^|/)target/', '^apps/desktop/src-tauri'],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
