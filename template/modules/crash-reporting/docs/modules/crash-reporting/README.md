# Module: crash-reporting

Self-hosted crash/error reporting for both processes — with the REDACTION POLICY
as the shipped, tested core and the transports as documented opt-in patches. The
policy lands as real code the moment you enable the module; the Sentry wiring is
copy-when-ready, because pointing a crash pipeline at an ingest host is a
deployment decision, not a scaffold default.

## What it adds

| File | Purpose |
| --- | --- |
| `apps/server/src/crash/redact.ts` | dependency-free redaction policy (DSNs, tokens, JWTs, e-mails, home paths, secret-shaped keys) |
| `apps/server/src/crash/redact.test.ts` | the policy's unit tests — run in the default vitest lane immediately |
| `docs/modules/crash-reporting/server-sentry.patch.md` | @sentry/node wiring: env contract, beforeSend → redaction, onError funnel |
| `docs/modules/crash-reporting/desktop-sentry.patch.md` | webview→host crash funnel, Rust sentry crate, PDB upload for the release lane, offline diagnostics bundle |

## Prerequisites

- None for the shipped code (it is dependency-free and tested).
- For the transports: a self-hosted Sentry/GlitchTip instance, its DSN, and — for
  readable native stacks — `SENTRY_URL`/`SENTRY_AUTH_TOKEN` secrets in the
  release lane. On-prem doctrine: your ingest host, never a third-party SaaS.

## How enabling works

```
npx tauri-postgres-agent-harness enable crash-reporting
```

copies the files. `redact.test.ts` joins `pnpm exec vitest run` (and therefore
the Stop hook and CI) automatically. The patches stay documentation until you
apply them — no gate-config change.

## How its gate can FAIL (anti-vacuity)

- Weaken the policy: delete the e-mail rule from `TEXT_REDACTIONS` in
  `redact.ts` → `redact.test.ts` fails in the default unit lane. That is the
  gate: the POLICY is enforced from day one, transport or not.
- After wiring Sentry: throw a test error containing a credentialed DSN (the
  dev-shaped `postgres://app_api:postgres@127.0.0.1/app` works) and an e-mail;
  assert the captured payload shows
  `[redacted]` / `[redacted-email]` (see the server patch, step 5) — this proves
  the wiring calls the policy, not just that the policy exists.
- Extend the fixtures with YOUR PII shapes (student identifiers, tenant names);
  a generic-shapes-only redaction test undertests your data.

## Honest limits

- The webview keeps its pinned CSP: crash events leave via the HOST (typed IPC
  command), never a new `connect-src` entry.
- The Rust side needs the policy PORTED (regexes + tests, 1:1) — documented in
  the desktop patch; there is no shared implementation across the language
  boundary.
- For egress-forbidden deployments, use the diagnostics-bundle path (desktop
  patch §4): same redaction, zero network.
