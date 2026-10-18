import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { SelectField, type SelectOption } from './select'
import { TypeBadge } from './type-badge'

const options: SelectOption[] = [
  { value: '', label: 'All types' },
  { value: 'dimmer', label: 'Dimmer', content: <TypeBadge color="#1f6feb">Dimmer</TypeBadge> },
  { value: 'gateway', label: 'Gateway' },
]

function Harness({ initial = '', error, hint, disabled }: { initial?: string; error?: string; hint?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <SelectField label="Type" value={value} onValueChange={setValue} options={options} error={error} hint={hint} disabled={disabled} />
      <output>value={value}</output>
    </>
  )
}

describe('SelectField', () => {
  it('is a labelled combobox that picks an option, also the empty one', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('combobox', { name: 'Type' })
    expect(trigger).toHaveTextContent('All types')

    await user.click(trigger)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All types', 'Dimmer', 'Gateway'])
    await user.click(screen.getByRole('option', { name: 'Dimmer' }))
    expect(screen.getByText('value=dimmer')).toBeInTheDocument()
    // Rich content shows in the trigger too: the colour dot.
    expect(trigger.querySelector('[data-testid="type-color"]')).toHaveStyle({ backgroundColor: '#1f6feb' })

    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'All types' }))
    expect(screen.getByText('value=')).toBeInTheDocument()
  })

  it('works with the keyboard and typeahead', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    screen.getByRole('combobox', { name: 'Type' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('g{Enter}')
    expect(screen.getByText('value=gateway')).toBeInTheDocument()
  })

  it('shows the error or hint like Field, and can be disabled', () => {
    const { rerender } = render(<Harness error="Choose a type." hint="Ignored" />)
    const trigger = screen.getByRole('combobox', { name: 'Type' })
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(trigger).toHaveAccessibleDescription('Choose a type.')

    rerender(<Harness hint="What the product is." disabled />)
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeDisabled()
  })
})
