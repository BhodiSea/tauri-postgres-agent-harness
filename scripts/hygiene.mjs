#!/usr/bin/env node
// Hygiene gate for the harness repo itself.
// 1. Leaked-string scan: nothing project-specific from the source codebase may
//    appear anywhere under template/ (the shipped artifact must be generic).
// 2. Placeholder closure: every {{VAR}} used in template/ must exist in the
//    installer's placeholder registry, and every registry var must be used.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE = join(ROOT, 'template')

// A gate that scans nothing is a false green — fail loudly, never skip.
if (!existsSync(TEMPLATE)) {
  console.error(`HYGIENE: FAIL — template dir not found at ${TEMPLATE}`)
  process.exit(1)
}

const LEAK_PATTERNS = [
  /cogvera/i,
  /medqbank/i,
  /uwa\b/i, // no client names in the shipped artifact
  /BhodiSea/, // template files must use {{GITHUB_OWNER}}, never the real handle
  /\/Users\//, // absolute developer paths
  /@cogveralabs/i,
  // Cross-porting detectors: these words appearing anywhere in template/ mean
  // a file was carried from the sibling Next.js+Supabase harness unadapted.
  /supabase/i,
  /vercel/i,
  // Credential shapes — none may ever ship, even as "examples".
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ/, // JWT structure (header.payload)
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // PEM private keys
  /minisign encrypted secret key/i, // Tauri updater signing key file header
  /TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*["'][^"'$@{]/, // literal signing key (env refs allowed)
  /[A-Za-z0-9._~-]{2,}8Q~[A-Za-z0-9._~-]{20,}/, // Entra/Azure client-secret shape
  /\/[^\s"']+\.gguf/, // absolute model paths are deployment config, never template content
  // Connection strings with credentials, except the documented local-dev
  // convention: password literally 'postgres', loopback host only.
  /postgres(?:ql)?:\/\/(?![a-z_]+:postgres@(?:127\.0\.0\.1|localhost))[^\s'"]+:[^\s'"]+@/,
]

// Files allowed to mention a pattern (path suffix → patterns allowed there).
const ALLOWLIST = new Map()

const failures = []

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

for (const file of walk(TEMPLATE)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // binary
  }
  const rel = file.slice(ROOT.length)
  for (const pattern of LEAK_PATTERNS) {
    if (!pattern.test(text)) continue
    const allowed = ALLOWLIST.get(rel)
    if (allowed?.some((a) => a.source === pattern.source)) continue
    const line = text.split('\n').findIndex((l) => pattern.test(l)) + 1
    failures.push(`${rel}:${line} matches leaked-string pattern ${pattern}`)
  }
}

// Placeholder closure (runs once the registry + manifest exist).
const registryPath = join(ROOT, 'installer/lib/placeholders.mjs')
if (existsSync(registryPath)) {
  // file:// URL, not the raw path — Windows absolute paths (D:\…) are not
  // importable by the ESM loader.
  const { PLACEHOLDERS } = await import(pathToFileURL(registryPath).href)
  const registered = new Set(Object.keys(PLACEHOLDERS))
  const used = new Set()
  for (const file of walk(TEMPLATE)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) used.add(m[1])
  }
  for (const v of used) {
    if (!registered.has(v)) failures.push(`template uses {{${v}}} but it is not in the placeholder registry`)
  }
  for (const v of registered) {
    if (!used.has(v)) failures.push(`placeholder registry declares ${v} but no template file uses it`)
  }
}

if (failures.length > 0) {
  console.error(`HYGIENE: FAIL (${failures.length})`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('HYGIENE: CLEAN')
