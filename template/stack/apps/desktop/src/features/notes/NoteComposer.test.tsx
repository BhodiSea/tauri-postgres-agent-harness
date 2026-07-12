import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NoteComposer } from './NoteComposer'
import type { SubmitOutcome } from './useCreateNote'

const submitStub = (outcome: SubmitOutcome) => vi.fn(() => Promise.resolve(outcome))

describe('NoteComposer', () => {
  it('submits the typed title through the Field/Input/Button primitives', async () => {
    const onSubmit = submitStub('settled')
    render(<NoteComposer status="idle" fieldError={null} onSubmit={onSubmit} />)

    const input = screen.getByLabelText<HTMLInputElement>('Add a note')
    fireEvent.change(input, { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    expect(onSubmit).toHaveBeenCalledWith({ title: 'Ship it' })
    // A settled (reconciled) outcome clears the draft.
    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('keeps the draft when the submit fails — the user retries without retyping', async () => {
    const onSubmit = submitStub('failed')
    render(<NoteComposer status="idle" fieldError={null} onSubmit={onSubmit} />)

    const input = screen.getByLabelText<HTMLInputElement>('Add a note')
    fireEvent.change(input, { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce()
    })
    await act(async () => {
      // flush the resolved outcome so a (buggy) clear would have landed
    })
    expect(input.value).toBe('Keep me')
  })

  it('while pending: input and button disable and the button reports "Adding…"', () => {
    render(<NoteComposer status="pending" fieldError={null} onSubmit={submitStub('settled')} />)

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Adding…' }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Add a note').disabled).toBe(true)
  })

  it('renders the inline field error through Field (aria-invalid + described-by)', () => {
    render(
      <NoteComposer
        status="idle"
        fieldError="Title is required"
        onSubmit={submitStub('rejected')}
      />,
    )

    const input = screen.getByLabelText('Add a note')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(screen.getByText('Title is required').id).toBe(describedBy)
  })
})
