import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('defaults to type=button and the solid variant tokens', () => {
    render(<Button>Go</Button>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toContain('bg-surface')
    expect(button.className).toContain('hover:border-accent')
  })

  it('applies the requested variant and size', () => {
    render(
      <Button variant="ghost" size="sm">
        X
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'X' })
    expect(button.className).toContain('text-ink-muted')
    expect(button.className).toContain('text-xs')
    expect(button.className).not.toContain('bg-surface')
  })

  it('forwards a ref (React 19 ref-as-prop) and fires onClick', () => {
    const ref = createRef<HTMLButtonElement>()
    const onClick = vi.fn()
    render(
      <Button ref={ref} onClick={onClick}>
        Y
      </Button>,
    )
    expect(ref.current).not.toBeNull()
    ref.current?.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('allows a type override and merges an extra className', () => {
    render(
      <Button type="submit" className="mt-3">
        Z
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Z' })
    expect(button.getAttribute('type')).toBe('submit')
    expect(button.className).toContain('mt-3')
  })
})
