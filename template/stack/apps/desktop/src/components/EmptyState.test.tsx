import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders title + description and passes through data-testid, no CTA by default', () => {
    render(<EmptyState data-testid="x-empty" title="Nothing here" description="Create one." />)
    expect(screen.getByTestId('x-empty')).toBeDefined()
    expect(screen.getByText('Nothing here')).toBeDefined()
    expect(screen.getByText('Create one.')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the optional CTA as a Button and runs it', () => {
    const onClick = vi.fn()
    render(<EmptyState title="T" description="D" cta={{ label: 'Reload', onClick }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
