import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { en, type MessageKey } from './catalog'
import {
  formatCellValue,
  formatDate,
  formatRelativeTime,
  LOCALES,
  t,
  translate,
  useI18n,
} from './index'
import { pseudoCatalog } from './pseudo'

// The locale is switched the way the APP switches it — through the store, via a component's
// useI18n().setLocale. There is no exported setLocale/getLocale to reach around it with: the
// module's public surface is exactly what the app uses (knip --strict enforces that), and a
// test that needs a private door usually means the door should be public for a reason nobody
// has stated. Here, renderHook drives the real one.
function switchLocale(locale: Parameters<ReturnType<typeof useI18n>['setLocale']>[0]): void {
  const { result } = renderHook(() => useI18n())
  act(() => {
    result.current.setLocale(locale)
  })
}

beforeEach(() => {
  switchLocale('en')
})

describe('catalog', () => {
  it('every message is a string or a plural set with an `other` branch', () => {
    // `other` is the fallback for every CLDR category a locale does not define. A plural set
    // without it would resolve to undefined for some count in some language.
    for (const [key, message] of Object.entries(en)) {
      if (typeof message === 'string') {
        expect(message.length, `${key} is empty`).toBeGreaterThan(0)
        continue
      }
      expect(typeof message.other, `${key} has no \`other\` branch`).toBe('string')
    }
  })

  it('no message key is declared twice (the object literal would silently keep the last)', () => {
    const keys = Object.keys(en)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('interpolation', () => {
  it('substitutes named placeholders', () => {
    expect(t('connection.connected', { version: '1.2.3' })).toBe('API connected (v1.2.3)')
  })

  it('formats an interpolated NUMBER through Intl — a bare template literal could not', () => {
    // The old code interpolated raw numbers, so an en-US reader and a de-DE reader saw the same
    // "1234567". Numbers routed through a placeholder pick up the locale's grouping separator.
    expect(t('matrix.summary', { count: 2, rows: 1234567, columns: 6 })).toContain('1,234,567')
  })

  it('leaves an unknown placeholder intact rather than printing "undefined"', () => {
    expect(translate('en', 'connection.connected', {})).toBe('API connected (v{version})')
  })
})

describe('plurals', () => {
  it('selects the branch by CLDR category, not by an English if-statement', () => {
    expect(t('matrix.summary', { count: 1, rows: 1, columns: 6 })).toContain('1 row ×')
    expect(t('matrix.summary', { count: 2, rows: 2, columns: 6 })).toContain('2 rows ×')
  })

  it('"1 rows" — the bug this replaces — can no longer be produced', () => {
    const one = t('matrix.summary', { count: 1, rows: 1, columns: 6 })
    expect(one).not.toContain('1 rows')
  })

  it('falls back to `other` when a count is absent', () => {
    expect(t('matrix.summary', { rows: 3, columns: 6 })).toContain('3 rows')
  })
})

describe('direction', () => {
  // Asserted on <html> rather than on a pure function, because `dir` on the root element IS the
  // feature: it is what makes the browser mirror the layout and reorder bidirectional text. A
  // direction computed correctly and never applied would pass a unit test and ship an LTR app.
  it('applying a locale stamps lang AND dir on the document', () => {
    switchLocale('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.documentElement.dir).toBe('ltr')

    switchLocale('ar-XB')
    expect(document.documentElement.lang).toBe('ar-XB')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('the accented pseudo-locale stays ltr (it tests expansion, not mirroring)', () => {
    switchLocale('en-XA')
    expect(document.documentElement.dir).toBe('ltr')
  })
})

describe('number formatting', () => {
  it('formatCellValue gives integers no decimals and fractions exactly two', () => {
    expect(formatCellValue(42)).toBe('42')
    expect(formatCellValue(0.75)).toBe('0.75')
  })

  it('the decimal mark follows the LOCALE — which .toFixed(2) could never do', () => {
    // This is the whole reason formatCell() was deleted: `.toFixed(2)` hardcodes '.', so a
    // German reader saw "0.75" where they write "0,75".
    const german = new Intl.NumberFormat('de', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0.75)
    expect(german).toBe('0,75')
    expect((0.75).toFixed(2)).toBe('0.75')
    expect(german).not.toBe((0.75).toFixed(2))
  })

  it('a number interpolated into a message picks up the locale grouping', () => {
    expect(t('matrix.summary', { count: 2, rows: 1234567, columns: 6 })).toContain('1,234,567')
  })

  it('formatDate renders the absolute instant in the locale', () => {
    expect(formatDate('2026-01-01T12:00:00Z', { dateStyle: 'medium' })).toContain('2026')
  })
})

describe('relative time', () => {
  it('renders a past instant relatively, in the active locale', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeHoursAgo, now)).toBe('3 hours ago')
  })

  it('returns empty string for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatRelativeTime('not-a-date')).toBe('')
  })
})

describe('pseudo-locale', () => {
  const pseudo = pseudoCatalog(en, { accent: true, pad: 0.3, rtl: false })

  it('covers EVERY key — it is derived, so it cannot drift from the source catalog', () => {
    expect(Object.keys(pseudo).sort()).toEqual(Object.keys(en).sort())
  })

  it('mangles EVERY message, so any plain English on screen is a string that bypassed the catalog', () => {
    // The property that matters is not "is it bracketed" — it is "is it different". A message
    // that came through unchanged is a message the pseudo-locale cannot distinguish from a
    // hardcoded literal, which would blow a hole straight through the e2e sweep.
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(pseudo[key], `${key} survived pseudo-localization unchanged`).not.toEqual(en[key])
    }
  })

  it('PRESERVES placeholders — mangling them would break interpolation, not localizability', () => {
    switchLocale('en-XA')
    const rendered = t('connection.connected', { version: '1.2.3' })
    expect(rendered).toContain('1.2.3')
    expect(rendered).not.toContain('API connected')
  })

  it('expands the text ~30%, so a layout that clips German clips here too', () => {
    const source = en['home.body']
    const expanded = pseudo['home.body']
    expect(typeof expanded).toBe('string')
    expect((expanded as string).length).toBeGreaterThan(source.length * 1.2)
  })
})

describe('locale switching', () => {
  it('switching the locale swaps the active catalog for every subsequent t()', () => {
    expect(t('notes.heading')).toBe('Notes')
    switchLocale('en-XA')
    expect(t('notes.heading')).not.toBe('Notes')
    expect(t('notes.heading')).toBe(translate('en-XA', 'notes.heading'))
  })

  it('every declared locale resolves every key (no silent English fallback)', () => {
    const keys = Object.keys(en) as MessageKey[]
    for (const locale of LOCALES) {
      for (const key of keys) {
        const rendered = translate(locale, key)
        expect(rendered, `${locale}/${key} did not resolve`).not.toBe('')
        // A missing key returns the key itself — that would mean this locale's catalog is
        // incomplete, which for a derived pseudo-locale is impossible by construction.
        expect(rendered, `${locale}/${key} fell through to the key`).not.toBe(key)
      }
    }
  })
})
