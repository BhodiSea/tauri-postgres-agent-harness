import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App shell', () => {
  it('renders the title bar, connection status region, and shortcut hints', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '{{PROJECT_NAME}}' })).toBeDefined()
    // role=status is the aria-live region the connection probe writes into.
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
  })
})
