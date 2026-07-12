import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field } from './Field'
import { Input } from './Input'

describe('Field', () => {
  it('wires the label to the control via htmlFor/id (no error props when valid)', () => {
    render(<Field label="Title">{(control) => <Input {...control} defaultValue="" />}</Field>)
    // getByLabelText resolving proves htmlFor === the control's id.
    const input = screen.getByLabelText('Title')
    expect(input.getAttribute('id')).not.toBeNull()
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('renders the inline error line and points aria-describedby at it, flagging aria-invalid', () => {
    render(
      <Field label="Title" error="Title is required">
        {(control) => <Input {...control} defaultValue="" />}
      </Field>,
    )
    const input = screen.getByLabelText('Title')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const errorLine = screen.getByText('Title is required')
    expect(errorLine.getAttribute('id')).toBe(describedBy)
  })

  it('treats an empty-string error as no error', () => {
    render(
      <Field label="Title" error="">
        {(control) => <Input {...control} defaultValue="" />}
      </Field>,
    )
    const input = screen.getByLabelText('Title')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBeNull()
  })

  it('merges an extra className onto the field wrapper', () => {
    render(
      <Field label="Title" className="mt-4">
        {(control) => <Input {...control} defaultValue="" />}
      </Field>,
    )
    const wrapper = screen.getByLabelText('Title').closest('div')
    expect(wrapper?.className).toContain('mt-4')
  })
})
