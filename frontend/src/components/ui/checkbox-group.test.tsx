import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CheckboxGroupField } from './checkbox-group'

const options = [
  { value: 'led', label: 'LED' },
  { value: 'halogen', label: 'Halogen' },
  { value: 'motor', label: 'Motor' },
]

describe('CheckboxGroupField', () => {
  it('sends the checked values in option order', async () => {
    const onChange = vi.fn()
    render(<CheckboxGroupField label="Loads" options={options} value={['motor']} onChange={onChange} />)

    await userEvent.click(screen.getByLabelText('LED'))
    expect(onChange).toHaveBeenLastCalledWith(['led', 'motor'])
  })

  it('shows values that are not options as checked boxes after the options; unticking removes only that one', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<CheckboxGroupField label="Loads" options={options} value={['gone', 'led', 'old']} onChange={onChange} />)

    const group = screen.getByRole('group', { name: 'Loads' })
    const boxes = within(group).getAllByRole('checkbox')
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual(['LED', 'Halogen', 'Motor', 'gone (not an option)', 'old (not an option)'])
    expect(screen.getByLabelText('gone (not an option)')).toBeChecked()

    await userEvent.click(screen.getByLabelText('gone (not an option)'))
    expect(onChange).toHaveBeenLastCalledWith(['led', 'old'])

    // Ticking an option keeps the unknown values.
    await userEvent.click(screen.getByLabelText('Halogen'))
    expect(onChange).toHaveBeenLastCalledWith(['led', 'halogen', 'gone', 'old'])

    rerender(<CheckboxGroupField label="Loads" options={options} value={['gone']} onChange={onChange} unknownLabel={(v) => `Unknown: ${v}`} />)
    expect(screen.getByLabelText('Unknown: gone')).toBeChecked()
  })
})
