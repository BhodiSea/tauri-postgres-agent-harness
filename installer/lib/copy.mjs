// Template tree walker: resolves storage names to installed paths, strips
// .tmpl suffixes, applies top-level dotless renames, and renders placeholders.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RENAMES } from './layout.mjs'
import { render } from './placeholders.mjs'

// Manifest keys, mode prefixes (SEEDED_PREFIXES 'apps/'), RETROFIT_ADDITIVE
// lookups, and doctor's '.claude/hooks/' classifier all assume POSIX
// separators. path.join yields backslashes on Windows, which silently
// reclassified every stack file as 'owned' there and made manifests
// non-portable across OSes — normalize once, at the only emit point.
export function toPosix(p) {
  return p.split(sep).join('/')
}

export function templateRoot() {
  // fileURLToPath, NOT URL.pathname: on Windows the latter yields /D:/… which
  // readdirSync cannot open — the walker's error guard then produced a silent
  // empty plan and `init` "succeeded" with 0 files (caught by bootstrap-windows CI).
  return fileURLToPath(new URL('../../template/', import.meta.url))
}

// Binary assets (icons, fonts, …) must round-trip byte-for-byte: decoding them
// as UTF-8 replaces non-UTF-8 bytes with U+FFFD and corrupts the file, and
// placeholder rendering makes no sense inside them. They are copied as Buffers.
const BINARY_EXT = /\.(png|ico|icns|gif|jpe?g|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|zip|bin)$/i

// Walk one template tree ('base' | 'stack' | 'modules/<name>') and return
// [{ storagePath, installPath, content }] with placeholders rendered.
export function planTree(tree, answers) {
  const root = join(templateRoot(), tree)
  const out = []
  walk(root, '')
  return out

  function walk(dir, relInstall) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const abs = join(dir, entry)
      const st = statSync(abs)
      // Top-level dotless names map back to their dot-path installs.
      const name = relInstall === '' && RENAMES.has(entry) ? RENAMES.get(entry) : entry
      if (st.isDirectory()) {
        walk(abs, join(relInstall, name))
        continue
      }
      const installPath = toPosix(join(relInstall, name.replace(/\.tmpl$/, '')))
      const content = BINARY_EXT.test(name)
        ? readFileSync(abs) // Buffer, verbatim — no placeholder rendering
        : render(readFileSync(abs, 'utf8'), answers)
      out.push({ storagePath: toPosix(join(tree, relInstall, entry)), installPath, content })
    }
  }
}
