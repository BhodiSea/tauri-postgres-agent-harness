import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './Toast'

// The auto-dismiss delay is a private constant in Toast.tsx (6000ms); advance
// past it to prove the timer fires.
const PAST_DISMISS_MS = 6000

function Emitter() {
  const toast = useToast()
  return (
    <button
      type="button"
      onClick={() => {
        toast.show('Saved')
      }}
    >
      emit
    </button>
  )
}

describe('Toast', () => {
  it('useToast throws outside a ToastProvider', () => {
    const original = console.error
    console.error = () => undefined
    try {
      expect(() => renderHook(() => useToast())).toThrow(/ToastProvider/)
    } finally {
      console.error = original
    }
  })

  it('shows a toast, then dismisses it via its dismiss button', () => {
    render(
      <ToastProvider>
        <Emitter />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'emit' }))
    expect(screen.getByText('Saved')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('auto-dismisses after the dismiss delay', () => {
    vi.useFakeTimers()
    try {
      render(
        <ToastProvider>
          <Emitter />
        </ToastProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'emit' }))
      expect(screen.getByText('Saved')).toBeDefined()
      act(() => {
        vi.advanceTimersByTime(PAST_DISMISS_MS)
      })
      expect(screen.queryByText('Saved')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
