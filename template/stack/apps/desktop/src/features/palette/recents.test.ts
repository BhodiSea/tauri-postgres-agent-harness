import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushRecent, readRecents } from './recents'

// The storage key is module-private; tests address it by the same literal so a
// drive-by rename (which would strand every user's persisted recents) fails here.
const STORAGE_KEY = 'palette.recents'

// The env has no real Web Storage — install an in-memory Storage per test
// (same convention as src/theme/theme.test.ts).
function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => {
      map.clear()
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readRecents', () => {
  it('reads empty storage as no recents', () => {
    expect(readRecents()).toEqual([])
  })

  it('round-trips what pushRecent persisted', () => {
    pushRecent('a')
    pushRecent('b')
    expect(readRecents()).toEqual(['b', 'a'])
  })

  it('resets on corrupt JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{definitely not json')
    expect(readRecents()).toEqual([])
  })

  it('resets on a non-array payload', () => {
    localStorage.setItem(STORAGE_KEY, '{"sneaky":"object"}')
    expect(readRecents()).toEqual([])
  })

  it('filters non-string entries and dedupes repeats', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 'a', null, 'b', 'a', { x: 1 }]))
    expect(readRecents()).toEqual(['a', 'b'])
  })

  it('re-caps an overlong historical payload at five', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
    expect(readRecents()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('pushRecent', () => {
  it('returns the new list AND persists it', () => {
    expect(pushRecent('a')).toEqual(['a'])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['a'])
  })

  it('floats a re-run id to the front without duplicating it', () => {
    pushRecent('a')
    pushRecent('b')
    pushRecent('c')
    expect(pushRecent('a')).toEqual(['a', 'c', 'b'])
  })

  it('caps at five, dropping the oldest', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) pushRecent(id)
    expect(readRecents()).toEqual(['f', 'e', 'd', 'c', 'b'])
  })

  it('recovers from a corrupt payload: the push replaces it wholesale', () => {
    localStorage.setItem(STORAGE_KEY, 'not even close')
    expect(pushRecent('a')).toEqual(['a'])
    expect(readRecents()).toEqual(['a'])
  })
})
