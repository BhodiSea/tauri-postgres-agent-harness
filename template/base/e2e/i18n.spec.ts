import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { translate } from '../apps/desktop/src/i18n'
import { en } from '../apps/desktop/src/i18n/catalog'
import { ROUTES } from '../apps/desktop/src/routes'
import { installMockIpc, makeNoteRows, stubDataRequests, stubHealthz } from './mock-ipc'

// The BEHAVIOURAL half of the i18n gate. tools/check-i18n.mjs is a text scan: it sees the shapes
// copy takes, not every expression that can produce a string. A message assembled at runtime from
// fragments, returned by a helper, or living in a const the scanner does not recognise is
// invisible to it. This lane is what makes the guarantee complete, and it does it with one idea:
//
//     Under the `en-XA` pseudo-locale EVERY catalog string comes back visibly mangled
//     (⟦Áççéñţéd·····⟧). So any plain-English text still on screen is, BY CONSTRUCTION, a string
//     that never went through the catalog.
//
// The assertion is therefore not "does it look translated" but the exact inverse, and it is
// falsifiable: take the `en` source strings and prove NONE of them survives verbatim in the DOM.
// Hardcode "Add a note" in a component and this reds, naming the string — no matter how the
// component got it there.
//
// The pseudo-locale is DERIVED from the catalog (src/i18n/pseudo.ts), so it is complete by
// construction and cannot rot; a hand-written fixture locale would silently fall back to English
// for any new key, which is precisely the failure it would exist to catch.
//
// The second half is RTL. `ar-XB` drives `dir="rtl"` through the real layout — the app had never
// rendered right-to-left, and a mirrored layout is where absolute positioning, physical margins
// and unlabelled icon buttons go wrong. Axe runs against it, and the document must not gain a
// horizontal scrollbar.
// SOURCE: pseudolocalization as a completeness check — the Unicode expansion/accent/bracket
// convention https://cldr.unicode.org/index/cldr-spec/pseudolocalization [corpus: harness/doctrine]

const PSEUDO_LOCALE = 'en-XA'
const RTL_LOCALE = 'ar-XB'

/** Persist a locale the way the app reads it, before any script runs. */
async function useLocale(page: Page, locale: string): Promise<void> {
  await page.addInitScript((value: string) => {
    localStorage.setItem('locale', value)
  }, locale)
}

/**
 * The English source strings that must NOT survive pseudo-localization.
 *
 * Placeholders are stripped and the remaining literal fragments are what we search for, so
 * `'API connected (v{version})'` contributes `API connected (v`. Short fragments are dropped:
 * a 3-character run like "Esc" collides with real content and with user DATA (note titles), and
 * a false red here would be worse than a missed string — it would teach people to distrust the
 * lane. The long strings carry the signal; there are plenty of them.
 */
function englishFragments(): string[] {
  const out = new Set<string>()
  for (const message of Object.values(en)) {
    const forms = typeof message === 'string' ? [message] : Object.values(message)
    for (const form of forms) {
      if (typeof form !== 'string') continue
      for (const fragment of form.split(/\{[a-zA-Z][\w.]*\}/)) {
        const cleaned = fragment.trim()
        if (cleaned.length >= 8) out.add(cleaned)
      }
    }
  }
  return [...out]
}

const FRAGMENTS = englishFragments()

async function mount(page: Page, path: string): Promise<void> {
  await installMockIpc(page)
  await stubHealthz(page, { kind: 'ok', version: '9.9.9' })
  await stubDataRequests(page, { items: makeNoteRows(12), nextCursor: null })
  await page.goto(path)
  await expect(page.locator('main')).not.toBeEmpty()
}

test('the catalog yields enough long English fragments to make this suite non-vacuous', () => {
  // If the catalog were empty, or every message were a bare placeholder, the sweep below would
  // pass by having nothing to look for. Assert it has real signal before trusting it.
  expect(FRAGMENTS.length).toBeGreaterThan(20)
})

for (const route of ROUTES) {
  test(`i18n: ${route.id} (${route.path}) renders NO hardcoded English under the pseudo-locale`, async ({
    page,
  }) => {
    await useLocale(page, PSEUDO_LOCALE)
    await mount(page, route.path)

    // Sanity first: the pseudo-locale is actually live. Without this, a broken locale switch
    // would make the whole sweep pass for the wrong reason (nothing is translated, so nothing
    // can be found untranslated).
    await expect(page.locator('html')).toHaveAttribute('lang', PSEUDO_LOCALE)
    const body = (await page.locator('body').innerText()).trim()
    // The positive control: the PSEUDO rendering of a string the shell always shows (the nav
    // link for this route) must actually be on screen. Asserted against the catalog's own
    // output rather than a marker character, so it stays true if the transform ever changes.
    const expected = translate('en-XA', route.labelKey)
    expect(
      body.includes(expected),
      `the pseudo-localized nav label (${expected}) is not on screen — the locale never applied, ` +
        'so the sweep below would pass vacuously',
    ).toBe(true)

    const leaked = FRAGMENTS.filter((fragment) => body.includes(fragment))
    expect(
      leaked,
      `these English source strings survived pseudo-localization on ${route.path}, which means ` +
        'they reached the screen WITHOUT going through the catalog — they are hardcoded ' +
        'somewhere the static i18n gate could not see (built at runtime, assembled from ' +
        'fragments, or returned by a helper).\n' +
        "FIX: add a key to apps/desktop/src/i18n/catalog.ts and render it with t('<key>').",
    ).toEqual([])
  })

  test(`i18n: ${route.id} (${route.path}) survives RTL — dir flips, layout holds, axe clean`, async ({
    page,
  }) => {
    await useLocale(page, RTL_LOCALE)
    await mount(page, route.path)

    // `dir` is the whole RTL story: it mirrors the layout, flips logical CSS properties and
    // reorders bidirectional runs. The app never set it before 0.1.6.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    // A mirrored layout is where physical margins and absolute positioning break. The document
    // must not gain a horizontal scrollbar — the same bar the reflow suite holds LTR to.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement
      return doc.scrollWidth - doc.clientWidth
    })
    expect(
      overflow,
      `the document scrolls horizontally by ${String(overflow)}px under dir="rtl" — a physical ` +
        'margin/padding or an absolutely-positioned element did not mirror. Use logical ' +
        'properties (ms-/me-/ps-/pe-, start/end) rather than left/right.',
    ).toBeLessThanOrEqual(1)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    for (const violation of results.violations) {
      console.error(`[axe rtl ${route.id}] ${violation.id}: ${violation.help}`)
      for (const node of violation.nodes) console.error(`  at ${node.target.join(' ')}`)
    }
    expect(results.violations, `axe violations on ${route.path} under RTL`).toEqual([])
  })
}
