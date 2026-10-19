import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { ComboboxField, type ComboboxOption } from './combobox'

const options: ComboboxOption[] = [
  { value: 'USD', label: 'USD – US Dollar' },
  { value: 'EUR', label: 'EUR – Euro' },
  { value: 'PKR', label: 'PKR – Pakistani Rupee', keywords: 'Pakistan' },
]

function Harness() {
  const [value, setValue] = useState('USD')
  return (
    <>
      <ComboboxField label="Currency" value={value} onValueChange={setValue} options={options} emptyText="Nothing found" />
      <output>value={value}</output>
    </>
  )
}

describe('ComboboxField', () => {
  it('shows the chosen label, filters while typing and picks with the keyboard', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Currency' })
    expect(input).toHaveValue('USD – US Dollar')

    await user.click(input)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await user.keyboard('rupee')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['PKR – Pakistani Rupee'])
    await user.keyboard('{Enter}')
    expect(screen.getByText('value=PKR')).toBeInTheDocument()
    expect(input).toHaveValue('PKR – Pakistani Rupee')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.clear(input)
    await user.keyboard('xyz')
    expect(screen.getByText('Nothing found')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('PKR – Pakistani Rupee')

    await user.click(input)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(screen.getByText('value=EUR')).toBeInTheDocument()
  })

  it('picks with the mouse', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('combobox', { name: 'Currency' }))
    await user.click(screen.getByRole('option', { name: 'EUR – Euro' }))
    expect(screen.getByText('value=EUR')).toBeInTheDocument()
  })
})
