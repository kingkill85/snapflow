import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { ComboboxField, type ComboboxOption } from './combobox'
import { FormDialog } from './dialog'

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

  it('Home/End jump, Tab picks the highlighted option, the list is named by the label', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Currency' })
    await user.click(input)
    expect(screen.getByRole('listbox', { name: 'Currency' })).toBeInTheDocument()
    await user.keyboard('{End}')
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-2$/))
    await user.keyboard('{Home}')
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-0$/))
    await user.keyboard('{ArrowDown}{Tab}')
    expect(screen.getByText('value=EUR')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // Closed, Tab moves on without changing anything.
    await user.click(input)
    await user.keyboard('{Escape}{Tab}')
    expect(screen.getByText('value=EUR')).toBeInTheDocument()
  })

  it('Escape in a dialog closes the list, a second Escape the dialog', async () => {
    const user = userEvent.setup()
    function InDialog() {
      const [open, setOpen] = useState(true)
      const [value, setValue] = useState('USD')
      return (
        <>
          <FormDialog open={open} onOpenChange={setOpen} title="Edit" submitLabel="Save" submitting={false} onSubmit={() => {}}>
            <ComboboxField label="Currency" value={value} onValueChange={setValue} options={options} />
          </FormDialog>
          <output>open={String(open)}</output>
        </>
      )
    }
    render(<InDialog />)
    await user.click(screen.getByRole('combobox', { name: 'Currency' }))
    const list = screen.getByRole('listbox')
    // Drawn inside the dialog (not clipped by its scrolling body, still in its focus trap).
    expect(screen.getByRole('dialog')).toContainElement(list)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByText('open=true')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByText('open=false')).toBeInTheDocument()
  })
})
