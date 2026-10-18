import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { TagsField } from './tags-field'

function Controlled({ initial = [] as string[], onChange = vi.fn() }) {
  const [value, setValue] = useState(initial)
  return (
    <TagsField
      label="Currents"
      suffix="A"
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

describe('TagsField', () => {
  it('adds items by Enter, the Add button and leaving the input, and removes them', async () => {
    const onChange = vi.fn()
    const u = userEvent.setup()
    render(<Controlled onChange={onChange} />)

    const input = screen.getByLabelText('Currents')
    await u.type(input, ' 1.5 {Enter}')
    await u.type(input, '2')
    await u.click(screen.getByRole('button', { name: 'Add' }))
    await u.type(input, '3')
    await u.tab()

    expect(onChange).toHaveBeenLastCalledWith(['1.5', '2', '3'])
    expect(screen.getByRole('list')).toHaveTextContent('1.5 A')
    // Blank input adds nothing.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await u.click(screen.getByRole('button', { name: 'Remove 2' }))
    expect(onChange).toHaveBeenLastCalledWith(['1.5', '3'])
  })

  it('describes the input with the error', () => {
    render(<TagsField label="Currents" value={[]} onChange={vi.fn()} hint="At most 4 items" error="Enter a number." />)
    expect(screen.getByLabelText('Currents')).toHaveAccessibleDescription('Enter a number.')
    expect(screen.getByLabelText('Currents')).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows the items labelled by the label when disabled, or "None"', () => {
    const { rerender } = render(<TagsField label="Currents" value={['1', '2']} onChange={vi.fn()} disabled />)
    const list = screen.getByRole('list', { name: 'Currents' })
    expect(list).toHaveTextContent('12')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<TagsField label="Currents" value={[]} onChange={vi.fn()} disabled />)
    expect(screen.getByText('None')).toBeInTheDocument()
  })
})
