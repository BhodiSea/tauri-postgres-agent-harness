# BUILD-SPEC — interlock contract for template authoring

Authoritative interface spec for `template/base` + `template/stack`. Every authoring
agent MUST follow this exactly; deviations require a note in the agent's report.
Where this spec and `designs.json`/`critic.json` conflict, THIS FILE WINS.

## Template storage rules (installer mechanics — violations break packaging)

- Every `package.json` under `template/` is stored as **`package.json.tmpl`** (the
  installer strips `.tmpl`; storing them bare corrupts npm packlist and pnpm workspace
  resolution inside the harness repo itself).
- **No nested dotfiles** anywhere under `template/` (npm packlist strips/abuses them).
  Top-level dotless names that map to dot-paths on install: `gitignore`, `github/`,
  `gitattributes`, `editorconfig`, `nvmrc`, `node-version`, `gitleaks.toml`,
  `dependency-cruiser.cjs`, `mcp.json`, `env.example`. Rust's usual `src-tauri/.gitignore`
  is folded into the root `gitignore` (`target/`).
- Placeholders: only `{{PROJECT_NAME}} {{PROJECT_SLUG}} {{PRODUCT_IDENTIFIER}}
  {{WINDOWS_PUBLISHER}} {{API_ORIGIN}} {{DB_NAME}} {{GITHUB_OWNER}} {{SECURITY_OWNERS}}
  {{DEFAULT_BRANCH}}` (registry-enforced closure: use each at least once overall, never
  invent new ones).
- Hygiene bans in template content (scripts/hygiene.mjs fails the repo otherwise):
  the literal harness owner handle, `/Users/` paths, the words `supabase`/`vercel`
  (case-insensitive), client names (uwa/cogvera/medqbank), credential shapes (JWTs,
  PEM keys, minisign secret headers, Azure `8Q~` secrets, absolute `.gguf` paths,
  postgres DSNs other than `postgres:postgres@127.0.0.1` / `@localhost`).

## Monorepo shape (installed result)

```
package.json                 # root, private; scripts: validate/typecheck/lint/format/knip/arch/test + harness:*
pnpm-workspace.yaml          # packages: apps/*, packages/*  + catalog (ALL versions live here)
tsconfig.json                # solution: references only
tsconfig.base.json           # shared max-strict compilerOptions
apps/desktop/                # Tauri 2 + React 19 + Vite SPA        (name: "desktop", private)
apps/server/                 # Hono + Node 22 API                    (name: "server", private)
packages/schema/             # @app/schema  — Zod contracts + Drizzle schema + migrations
packages/importer/           # @app/importer — deterministic parsers + fast-check PBT
packages/eval/               # @app/eval    — Inference/Embedding ports + fixture-scored eval
```

Workspace deps use `"@app/schema": "workspace:*"`. All external versions via
`catalog:` references; the catalog in pnpm-workspace.yaml is the ONLY place version
numbers appear (package.json.tmpl files say `"catalog:"`).

## Catalog (agent T verifies every version exists on the registry before writing;
if a listed major is not yet stable, use latest stable and record the deviation)

typescript (target 6.0.x, else latest 5.x) · @biomejs/biome 2.x · eslint 9.x ·
typescript-eslint 8.x · eslint-plugin-jsx-a11y · eslint-plugin-react-hooks (latest
supporting React 19/compiler) · eslint-plugin-sonarjs · knip · dependency-cruiser ·
vitest (target 4.x else latest 3.x) + @vitest/coverage-v8 · jsdom ·
@testing-library/react + @testing-library/jest-dom + @testing-library/user-event ·
lefthook · @commitlint/cli + @commitlint/config-conventional · cspell · tsx ·
fast-check · zod 4.x · hono 4.x · @hono/node-server · @hono/zod-openapi (zod-4
compatible) · jose · pino + pino-pretty · postgres (postgres.js driver) ·
drizzle-orm + drizzle-zod + drizzle-kit (pin EXACT for drizzle-kit + any rc tool) ·
react 19.x + react-dom · vite + @vitejs/plugin-react · babel-plugin-react-compiler
(EXACT pin) · tailwindcss 4.x + @tailwindcss/vite · clsx + tailwind-merge ·
@tauri-apps/api 2.x · @tauri-apps/cli 2.x (EXACT pin) · @tauri-apps/plugin-log

Rust (apps/desktop/src-tauri/Cargo.toml; verify on crates.io): tauri 2.x,
tauri-build, serde + serde_json, log, tauri-plugin-log, specta + tauri-specta
(EXACT pin if rc). `rust-toolchain.toml` pins a current stable channel by version.
`Cargo.lock` is committed.

## Cross-cutting contracts

- **Ports/origins**: server listens on `PORT` env, default **8787**. Desktop dev
  origin `http://localhost:1420` (Vite/tauri default). `{{API_ORIGIN}}` appears in
  the committed tauri.conf.json CSP `connect-src` and in env.example.
- **Env (env.example, root)**: `DATABASE_URL=postgres://app_api:app_api@127.0.0.1:5432/{{DB_NAME}}`
  … wait — hygiene DSN exception only allows `postgres:postgres@`. Use
  `DATABASE_URL=` empty with a comment showing shape, or extend? RESOLVED: env.example
  ships **empty values with comment lines** describing the local-dev defaults;
  docker-compose.yml is the single carrier of the dev DSN and uses
  `postgres:postgres@127.0.0.1` for the superuser bootstrap only. Vars:
  `DATABASE_URL` (app_api role), `MIGRATOR_DATABASE_URL` (app_migrator), `PORT`,
  `LOG_LEVEL`, `AUTH_MODE=stub|entra`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`,
  `API_AUDIENCE`, `VITE_API_ORIGIN` (desktop dev only; NEVER a secret — the
  write-guard bans VITE_-prefixed secret-ish names).
- **Database roles** (created by docker-compose init SQL, not migrations):
  `app_migrator` (owns schema, runs migrations), `app_api` (login role the server
  uses; NOT superuser; subject to FORCE RLS). RLS identity = GUC **`app.user_id`**
  set per-request via `SET LOCAL` inside a transaction
  (`set_config('app.user_id', $uuid, true)`). Policies read
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern).
- **Demo domain — `notes`** (proves every gate honestly):
  `notes(id uuid pk default gen_random_uuid(), owner_id uuid not null,
  title text not null, body text not null default '', embedding vector(1024),
  source_model text, source_confidence real, created_at timestamptz not null default now())`
  — ENABLE + FORCE RLS, four per-operation policies (select/insert/update/delete)
  scoped to `owner_id = (select current_setting('app.user_id', true)::uuid)`;
  GRANT select/insert/update/delete TO app_api. `source_model`/`source_confidence`
  are the ai-provenance example columns.
- **EMBEDDING_DIM = 1024** — exported const in `@app/schema`, used by the vector
  column and asserted by a schema unit test.
- **Auth**: `AUTH_MODE=stub|entra`, byte-identical verification path (jose
  `jwtVerify` with pinned iss/aud/alg ES256|RS256, `clockTolerance: 300`).
  stub = `createLocalJWKSet` over a JWKS JSON generated at dev time by
  `apps/server/scripts/mint-dev-token.mjs` (writes `.dev-auth/jwks.json` +
  prints a token; `.dev-auth/` is gitignored). entra = `createRemoteJWKSet`
  against the tenant discovery URL from env. **Boot-time fatal when
  `NODE_ENV=production && AUTH_MODE=stub`** — unit-tested. Clock-skew unit
  tests at ±4 min (pass) and ±6 min (fail).
- **DAL law**: routes never touch the db driver; only `apps/server/src/dal/*`
  does, and every DAL function runs inside `withUserContext(userId, fn)`
  (src/db/context.ts) which opens a tx and `SET LOCAL app.user_id`. DAL returns
  Zod-parsed DTOs from `@app/schema`, never raw driver rows.
- **Contracts**: `@hono/zod-openapi` routes; `apps/server/openapi.json` is
  COMMITTED and regenerated by `apps/server/scripts/emit-openapi.ts` (run via
  tsx); stable-stringified (sorted keys, trailing newline).
- **Version skew**: desktop sends `x-client-version` (from tauri.conf version);
  server middleware compares major against its own package version → 409 JSON
  `{ error: 'version_skew' }` on mismatch; applied to every `/api/*` route
  (unit test asserts coverage by walking the route table); `/healthz` exempt.
- **SSE demo**: `GET /api/events/demo` streams 3 ticks then closes; abort
  propagation unit-tested in-process (client abort → server generator finally).
- **Health**: `GET /healthz` → `{ ok: true, version }` (no auth). Desktop
  connection-status probe polls it and Zod-parses the shape.
- **Keyboard registry**: `apps/desktop/src/keyboard/registry.ts` exports
  `SHORTCUTS: readonly Shortcut[]` (`{ id, keys, description, scope }`); the
  WCAG 2.1.4 unit test iterates the registry and fails on any unmodified
  single-printable-character global shortcut.
- **Tauri**: `tauri.conf.json` → `identifier: "{{PRODUCT_IDENTIFIER}}"`,
  `app.security.csp` = `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; connect-src 'self' {{API_ORIGIN}}`,
  `app.security.pattern` = `{ "use": "isolation", "options": { "dir": "../isolation" } }`,
  bundle targets `["nsis"]`, `windows.webviewInstallMode` = `{ "type": "offlineInstaller" }`.
  `capabilities/main.json`: main window, `core:default` + log permission only.
  One demo `#[tauri::command] fn app_version() -> String`; tauri-specta exports
  committed bindings to `apps/desktop/src/ipc/bindings.ts`; UI imports tauri APIs
  ONLY via `src/ipc/` (lint-enforced later).
  `tools/identity.lock.json` = `{ "identifier": "{{PRODUCT_IDENTIFIER}}" }`.
- **Rust host quality**: `unsafe_code = "forbid"`, `[lints.clippy] all = "deny"`
  … (workspace lints table), tauri-plugin-log wired, `webview_process_failed`
  structured-log handler stub, `build.rs` embeds a Windows manifest enabling
  `longPathAware`.
- **Provenance**: non-trivial decision sites (RLS SQL, auth verification, CSP,
  retry/timeout constants, vector index choices) carry
  `// SOURCE: <authority> [corpus: <id>]` on or above the line (`--` for SQL).
  Corpus ids will resolve against `tools/mcp/corpus/index.json` (authored in the
  gates wave; use ids of the form `tauri/isolation`, `postgres/rls-initplan`,
  `entra/jwt-verify`, `harness/doctrine` and list every id you cite in your report).
- **Eval package**: `InferenceProvider` / `EmbeddingProvider` interfaces
  (chat/JSON-constrained + vision; embed), `FakeInferenceProvider` for tests,
  a versioned prompt at `packages/eval/prompts/extract.v1.md`, pinned fixture
  input/expected at `packages/eval/fixtures/`, and a scoring runner
  (precision/recall/F1 per axis) unit-tested against the fixture. NO live model
  calls anywhere. `tools/prompts.lock.json` maps prompt path → sha256 (agent P
  computes real hashes).
- **Importer package**: zero-dep TSV/CSV parser demo `parseTable()` with
  fast-check property tests (round-trip, quote/escape invariants) + one pinned
  fixture file.
- **Vitest**: root `vitest.config.ts` defines projects `unit-node`
  (packages/**, apps/server; environment node) and `unit-dom` (apps/desktop;
  jsdom). All tests colocated as `*.test.ts(x)` or under `tests/unit/`.
- **tsc -b**: every package `composite: true`, `tsconfig.json` extends
  `../../tsconfig.base.json`; root solution references all five. Base flags:
  strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  noPropertyAccessFromIndexSignature, noImplicitOverride, noFallthroughCasesInSwitch,
  verbatimModuleSyntax, isolatedModules, skipLibCheck, moduleResolution bundler
  (desktop) / node16-style for server+packages as appropriate — agent T decides
  the exact split and documents it in tsconfig comments.
- **Lint**: eslint flat root config, typescript-eslint strictTypeChecked +
  stylisticTypeChecked with projectService; jsx-a11y strict on apps/desktop;
  react-hooks + react compiler rule; sonarjs cognitive-complexity ≤ 15 (error);
  `no-restricted-imports` banning `recharts|visx|d3-selection|@nivo/*` under
  `apps/desktop/src/features/{matrix,graph}/**`, and banning
  `@tauri-apps/api`/`@tauri-apps/plugin-*` outside `apps/desktop/src/ipc/**` +
  `src/keyboard/**`. Biome = formatter + import organizer ONLY (linter off except
  a11y-free correctness basics; no overlap with eslint).
- **depcruise law** (.dependency-cruiser.cjs): no circulars; apps/desktop must
  not resolve `postgres|drizzle-orm|pino|@hono/*` nor anything in `apps/server`;
  `drizzle-zod` + `drizzle-orm` only inside `packages/schema` and `apps/server`
  (orm in server allowed, drizzle-zod schema-only); `@app/eval` adapters are the
  only allowed importers of LLM SDK modules (encode with a forbidden rule against
  `openai|@anthropic-ai|ollama` from everywhere except `packages/eval/src/adapters`).
- **Gate satisfiability**: your files must pass `biome ci`, `tsc -b`,
  `eslint --max-warnings 0`, `knip --strict` (no unused exports/deps — wire
  everything you add), and the future gates you can anticipate from the chain in
  `template/base/tools/harness.config.mjs` (already written — read it).

## Root package.json.tmpl scripts (agent T)

`validate`→`node tools/validate.mjs`, `typecheck`→`tsc -b`, `lint`/`lint:fix`,
`format`→`biome check --write .`, `knip`, `arch`→depcruise command, `test`→
`vitest run`, `test:rls`→`node tests/rls/run-rls.mjs`, `db:up`→`docker compose up -d db`,
`db:migrate`→`pnpm --filter @app/schema exec drizzle-kit migrate`,
`dev:server`, `dev:desktop`, `openapi:emit`. Name `{{PROJECT_SLUG}}`, private,
`packageManager` pnpm 11 exact, engines node >=22.

## Ownership (write ONLY inside your paths)

- **T** `template/base/`: pnpm-workspace.yaml, package.json.tmpl (root),
  tsconfig.json, tsconfig.base.json, biome.jsonc, eslint.config.mjs, knip.json,
  dependency-cruiser.cjs, vitest.config.ts, lefthook.yml, commitlint.config.mjs,
  cspell.json, editorconfig, gitattributes, gitignore, nvmrc, node-version,
  env.example, gitleaks.toml, renovate.json, rust-toolchain.toml, deny.toml,
  docker-compose.yml (+ db/init/01-roles.sql), tools/identity.lock.json,
  tools/rls-exempt.json (empty list + comment)
- **S** `template/stack/packages/schema/`
- **V** `template/stack/apps/server/`
- **D** `template/stack/apps/desktop/`
- **P** `template/stack/packages/{importer,eval}/` + `template/base/tools/prompts.lock.json`

(docker-compose mounts `db/init/`; T stores it dotless-safe as `db/init/01-roles.sql`
under template/base.)
