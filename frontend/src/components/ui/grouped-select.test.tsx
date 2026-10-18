import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { GroupedSelect, type SelectGroup } from './grouped-select'

const groups: SelectGroup[] = [
  { label: 'Product', options: [{ value: 'product.modelNumber', label: 'Model number' }, { value: 'product.name', label: 'Name', disabled: true }] },
  { label: 'Empty', options: [] },
  { label: 'Variant', options: [{ value: 'variant.sku', label: 'SKU' }, { value: 'variant.price', label: 'Price' }] },
]

function Harness({ initial = '', disabled }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <GroupedSelect aria-label="Imported as" value={value} onValueChange={setValue} options={[{ value: '', label: 'Not imported' }]} groups={groups} disabled={disabled} />
      <output>value={value}</output>
    </>
  )
}

describe('GroupedSelect', () => {
  it('shows the free options, then the titled groups without empty ones; disabled options cannot be picked', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('combobox', { name: 'Imported as' })
    expect(trigger).toHaveTextContent('Not imported')
    await user.click(trigger)
    const listed = screen.getAllByRole('group')
    expect(listed.map((g) => g.firstChild?.textContent)).toEqual(['Product', 'Variant'])
    expect(within(listed[0]).getByRole('option', { name: 'Name' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(within(listed[0]).getByRole('option', { name: 'Name' }))
    expect(screen.getByText('value=')).toBeInTheDocument()
    await user.click(within(listed[1]).getByRole('option', { name: 'Price' }))
    expect(screen.getByText('value=variant.price')).toBeInTheDocument()
    expect(trigger).toHaveTextContent('Price')
  })

  it('works with the keyboard across groups, skipping disabled options, and back to the empty value', async () => {
    const user = userEvent.setup()
    render(<Harness initial="variant.sku" />)
    screen.getByRole('combobox', { name: 'Imported as' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    // From SKU up: Model number (Name is disabled), then Not imported.
    await user.keyboard('{ArrowUp}{Enter}')
    expect(screen.getByText('value=product.modelNumber')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowUp}{Enter}')
    expect(screen.getByText('value=')).toBeInTheDocument()
  })

  it('shows the placeholder while the value matches no option', () => {
    render(<GroupedSelect aria-label="Field" value="attribute.gone" onValueChange={() => {}} groups={groups} placeholder="Choose a field" />)
    expect(screen.getByRole('combobox', { name: 'Field' })).toHaveTextContent('Choose a field')
  })

  it('does not open while disabled', async () => {
    const user = userEvent.setup()
    render(<Harness disabled />)
    const trigger = screen.getByRole('combobox', { name: 'Imported as' })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
