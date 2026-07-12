import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Command, CommandPalette } from './CommandPalette'

// Direct component tests for the grouped, ranked, recents-pinned palette; the
// shell-level wiring (mod+k, running a command swaps dialogs) stays in
// App.test.tsx. Recents persist under 'palette.recents' (recents.ts); the env
// has no real Web Storage, so each test gets an in-memory Storage (same
// convention as src/theme/theme.test.ts).

const STORAGE_KEY = 'palette.recents'

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

function makeCommands(onRun: (id: string) => void): readonly Command[] {
  const command = (
    id: string,
    title: string,
    group: Command['group'],
    hints: { subtitle?: string; keys?: string } = {},
  ): Command => ({
    id,
    title,
    group,
    ...hints,
    run: () => {
      onRun(id)
    },
  })
  return [
    command('nav.home', 'Go to Home', 'Navigation', { subtitle: '/' }),
    command('nav.matrix', 'Go to Matrix', 'Navigation', { subtitle: '/matrix' }),
    command('theme.light', 'Use light theme', 'Theme'),
    command('theme.dark', 'Use dark theme', 'Theme'),
    command('shortcuts.show', 'Show keyboard shortcuts', 'View', { keys: 'mod+/' }),
  ]
}

function renderPalette(onRun: (id: string) => void = () => undefined) {
  const onClose = vi.fn()
  render(<CommandPalette open={true} onClose={onClose} commands={makeCommands(onRun)} />)
  return { onClose, input: screen.getByRole('combobox', { name: 'Search commands' }) }
}

function optionTitles(): readonly string[] {
  return screen
    .getAllByRole('option')
    .map((option) => option.querySelector('span')?.textContent ?? '')
}

function headerNames(): readonly string[] {
  return screen.getAllByRole('group').map((group) => {
    const labelId = group.getAttribute('aria-labelledby') ?? ''
    return document.getElementById(labelId)?.textContent ?? ''
  })
}

describe('CommandPalette sections', () => {
  it('renders group headers in registration order on the empty query', () => {
    renderPalette()
    expect(headerNames()).toEqual(['Navigation', 'Theme', 'View'])
    expect(optionTitles()).toEqual([
      'Go to Home',
      'Go to Matrix',
      'Use light theme',
      'Use dark theme',
      'Show keyboard shortcuts',
    ])
  })

  it('re-ranks and regroups as the user types: a group ranks by its best member', () => {
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'tm' } })
    // Pinned in fuzzyScore.test.ts: matrix (two boundary hits) > home > dark > light.
    expect(optionTitles()).toEqual([
      'Go to Matrix',
      'Go to Home',
      'Use dark theme',
      'Use light theme',
    ])
    expect(headerNames()).toEqual(['Navigation', 'Theme'])
  })

  it('renders subtitle and keys hints right of the title', () => {
    renderPalette()
    const shortcuts = screen.getByRole('option', { name: /Show keyboard shortcuts/ })
    expect(within(shortcuts).getByText('mod+/')).toBeDefined()
    const home = screen.getByRole('option', { name: /Go to Home/ })
    expect(within(home).getByText('/')).toBeDefined()
  })

  it('shows the disabled empty state when nothing matches', () => {
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'zzzz' } })
    expect(screen.getByRole('option', { name: 'No matching command' })).toBeDefined()
  })
})

describe('CommandPalette keyboard model', () => {
  it('walks the FLAT ranked list across section boundaries and runs on Enter', () => {
    const ran: string[] = []
    const { input, onClose } = renderPalette((id) => ran.push(id))
    fireEvent.change(input, { target: { value: 'tm' } })
    // Two ArrowDowns cross from the Navigation section into Theme.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-option-2')
    expect(screen.getByRole('option', { name: /Use dark theme/ }).id).toBe('palette-option-2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(ran).toEqual(['theme.dark'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clamps ArrowUp at the first option and ArrowDown at the last', () => {
    const { input } = renderPalette()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-option-0')
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-option-4')
  })
})

describe('CommandPalette recents', () => {
  it('pins a Recents section first on the empty query, duplicating the command in its home group', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['theme.dark']))
    renderPalette()
    expect(headerNames()).toEqual(['Recents', 'Navigation', 'Theme', 'View'])
    // The recent command renders twice — under Recents AND its home group —
    // with distinct flat-index DOM ids.
    const copies = screen.getAllByRole('option', { name: /Use dark theme/ })
    expect(copies.map((option) => option.id)).toEqual(['palette-option-0', 'palette-option-4'])
  })

  it('replaces Recents with ranked results as soon as the user types', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['theme.dark']))
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'home' } })
    expect(headerNames()).toEqual(['Navigation'])
    fireEvent.change(input, { target: { value: '' } })
    expect(headerNames()).toEqual(['Recents', 'Navigation', 'Theme', 'View'])
  })

  it('filters recents ids whose command is not currently registered', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['matrix.jump-top', 'nav.home']))
    renderPalette()
    const recents = screen.getByRole('group', { name: 'Recents' })
    expect(within(recents).getAllByRole('option')).toHaveLength(1)
    expect(within(recents).getByRole('option', { name: /Go to Home/ })).toBeDefined()
  })

  it('records a run command at the front of the persisted recents', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['nav.home']))
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'dark' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual([
      'theme.dark',
      'nav.home',
    ])
  })

  it('survives a corrupt recents payload without a Recents section', () => {
    localStorage.setItem(STORAGE_KEY, '[[[corrupt')
    renderPalette()
    expect(headerNames()).toEqual(['Navigation', 'Theme', 'View'])
  })
})
