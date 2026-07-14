// Canary tests for the i18n gate (G22): spawn the real gate against a temp tree and assert a
// hardcoded user-facing string reds, the Intl boundary reds, a dead catalog key reds, the
// reviewed allowlist mutes a finding, a malformed/stale allowlist fails CLOSED, the gate
// self-disables when the seam is not installed, and a pre-0.1.6 baseVersion ramps to a NOTE.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-i18n.mjs', import.meta.url))
const SRC = 'apps/desktop/src'

// The gate reads its message keys out of the catalog TEXT (`'key':`), exactly as it ships.
const CATALOG = (keys) => `export const en = {
${keys.map((k) => `  '${k}': 'copy for ${k}',`).join('\n')}
} as const
export type MessageKey = keyof typeof en
`

/** @param {{files?: Record<string,string>, catalog?: string[]|null, allow?: unknown, manifest?: string}} opts */
function fixture({ files = {}, catalog = ['a.key'], allow = null, manifest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tpah-i18n-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, SRC), { recursive: true })
  if (catalog !== null) {
    mkdirSync(join(dir, `${SRC}/i18n`), { recursive: true })
    writeFileSync(join(dir, `${SRC}/i18n/catalog.ts`), CATALOG(catalog))
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, SRC, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  if (allow !== null) {
    writeFileSync(
      join(dir, 'tools/i18n-allow.json'),
      typeof allow === 'string' ? allow : JSON.stringify(allow),
    )
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), manifest)
  }
  return dir
}

function runGate(dir) {
  const env = { ...process.env }
  delete env.CI
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// A component that renders every key it is given, so the dead-key check stays satisfied and
// the test under examination is the only thing that can red.
const USES = (keys) =>
  `import { useI18n } from '../i18n'
export function Widget() {
  const { t } = useI18n()
  return <div>{${keys.map((k) => `t('${k}')`).join('}{')}}</div>
}
`

test('i18n: a hardcoded JSX text child reds, naming the string', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `export function Widget() {
  return <h2 className="x">Ready to build</h2>
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Ready to build"'), r.out)
  assert.ok(r.out.includes('JSX text'), r.out)
})

test('i18n: a hardcoded user-facing ATTRIBUTE reds (aria-label/title/placeholder/label/alt)', () => {
  for (const attr of ['aria-label', 'title', 'placeholder', 'label', 'alt']) {
    const dir = fixture({
      files: {
        'Widget.tsx': `export function Widget() {
  return <input ${attr}="Search commands" />
}
`,
        'Uses.tsx': USES(['a.key']),
      },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${attr} must red\n${r.out}`)
    assert.ok(r.out.includes('"Search commands"'), r.out)
    assert.ok(r.out.includes(`${attr} attribute`), r.out)
  }
})

test('i18n: copy in an OBJECT literal reds — the ROUTES manifest and shortcut registry hold copy too', () => {
  for (const key of ['label', 'title', 'subtitle', 'description']) {
    const dir = fixture({
      files: {
        'routes.ts': `export const ROUTES = [{ id: 'home', ${key}: 'Home screen' }]\n`,
        'Uses.tsx': USES(['a.key']),
      },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${key}: must red\n${r.out}`)
    assert.ok(r.out.includes('"Home screen"'), r.out)
  }
})

test('i18n: machine-facing literals are NOT copy (a path, a token, a kebab id)', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `export function Widget() {
  return <a href="/healthz" title="/matrix" className="text-ink" data-testid="home-empty" />
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: TypeScript generics are not JSX — a .ts file with <T> reds nothing', () => {
  // `useListQuery<T>(fetcher: ListFetcher<T>)` looks exactly like a tag with text between it.
  // The scan reported the code that followed as user-facing copy until it stopped looking for
  // JSX in files that cannot contain any.
  const dir = fixture({
    files: {
      'useListQuery.ts': `export function useListQuery<T>(fetcher: ListFetcher<T>): T | null {
  return null
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: an arrow function is not a tag — `=>` never opens JSX text', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `const keys = SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys])
export function Widget() {
  return <div />
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: Intl / toLocale* / toFixed outside src/i18n reds', () => {
  for (const call of [
    'new Intl.NumberFormat("en").format(1)',
    'value.toLocaleString()',
    'value.toFixed(2)',
  ]) {
    const dir = fixture({
      files: { 'fmt.ts': `export const x = ${call}\n`, 'Uses.tsx': USES(['a.key']) },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${call} must red\n${r.out}`)
    assert.ok(r.out.includes('outside apps/desktop/src/i18n/'), r.out)
  }
})

test('i18n: .toFixed(2) reds with the reason — it hardcodes the decimal mark', () => {
  const dir = fixture({
    files: { 'fmt.ts': 'export const x = value.toFixed(2)\n', 'Uses.tsx': USES(['a.key']) },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('0,75'), r.out) // the German reader in the message
})

test('i18n: a DEAD catalog key reds — copy nothing renders is copy that rots', () => {
  const dir = fixture({
    catalog: ['a.key', 'orphan.key'],
    files: { 'Uses.tsx': USES(['a.key']) },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("'orphan.key' is never rendered"), r.out)
})

test('i18n: a dynamically-built key resolves by its static PREFIX (no false dead-key)', () => {
  // `t(`theme.switch.${next}`)` renders all three, and the check must understand that rather
  // than reporting the whole family as dead.
  const dir = fixture({
    catalog: ['theme.switch.light', 'theme.switch.dark', 'theme.switch.system'],
    files: {
      'Uses.tsx': `import { useI18n } from '../i18n'
export function Widget({ next }: { next: string }) {
  const { t } = useI18n()
  return <div>{t(\`theme.switch.\${next}\`)}</div>
}
`,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: the reviewed allowlist mutes a finding; a stale or malformed one FAILS CLOSED', () => {
  const files = {
    'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
    'Uses.tsx': USES(['a.key']),
  }
  const muted = runGate(
    fixture({
      files,
      allow: { comment: 'x', allow: [{ site: `${SRC}/Widget.tsx:2`, reason: 'a brand name' }] },
    }),
  )
  assert.equal(muted.code, 0, muted.out)

  // Malformed shape (no reason) must never open the gate.
  const noReason = runGate(fixture({ files, allow: { allow: [{ site: `${SRC}/Widget.tsx:2` }] } }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('every entry must be'), noReason.out)

  // Not even an object with an `allow` array.
  const wrongShape = runGate(fixture({ files, allow: [{ site: 'x:1', reason: 'y' }] }))
  assert.equal(wrongShape.code, 1, wrongShape.out)

  // Unparseable JSON fails closed rather than being ignored.
  const broken = runGate(fixture({ files, allow: '{ not json' }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('not valid JSON'), broken.out)
})

test('i18n: the gate SELF-DISABLES when the locale seam is not installed', () => {
  // An upgraded consumer has no catalog until they adopt it. A gate that reds on its own
  // absence is exactly the ambush the ramp doctrine forbids.
  const dir = fixture({
    catalog: null,
    files: { 'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n' },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(r.out.includes('--refresh-seeded'), r.out)
})

test('i18n: a pre-0.1.6 baseVersion downgrades findings to a ramp NOTE (green)', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
      'Uses.tsx': USES(['a.key']),
    },
    manifest: JSON.stringify({ harnessVersion: '0.1.6', baseVersion: '0.1.4' }),
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE — (ramp)'), r.out)
  assert.ok(r.out.includes('"Ready to build"'), r.out)
})

test('i18n: turn-fatal once baseVersion reaches 0.1.6', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
      'Uses.tsx': USES(['a.key']),
    },
    manifest: JSON.stringify({ harnessVersion: '0.1.6', baseVersion: '0.1.6' }),
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('i18n: FAIL'), r.out)
})

test('i18n: a clean tree passes and reports what it scanned', () => {
  const dir = fixture({ files: { 'Uses.tsx': USES(['a.key']) } })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('no hardcoded copy'), r.out)
})
