import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { CheckboxGroupField } from './checkbox-group'
import { DataTable } from './data-table'
import { Field } from './field'
import { SwitchField } from './switch'

describe('required fields', () => {
  it('mark the label, not the name, and tell assistive technology', () => {
    render(
      <>
        <Field label="Key" required hint="e.g. dimmer" />
        <CheckboxGroupField label="Colour" required options={[{ value: 'white', label: 'White' }]} value={[]} onChange={() => {}} />
      </>,
    )
    const key = screen.getByLabelText('Key')
    expect(key).toHaveAttribute('aria-required', 'true')
    expect(key).toHaveAccessibleDescription('e.g. dimmer')
    expect(key.parentElement).toHaveTextContent('Key*')
    expect(screen.getByRole('group', { name: 'Colour' })).toHaveAccessibleDescription('Required')
  })
})

describe('SwitchField', () => {
  it('is a switch named by its label, described by its hint', async () => {
    const user = userEvent.setup()
    render(<SwitchField label="Active" hint="Inactive ones are hidden." defaultChecked />)
    const toggle = screen.getByRole('switch', { name: 'Active' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription('Inactive ones are hidden.')
    await user.click(screen.getByText('Active'))
    expect(toggle).not.toBeChecked()
  })
})

describe('DataTable', () => {
  it('labels each line of a phone card with its header, outside the cell text', () => {
    type Row = { id: string; image: string; name: string; sku: string }
    render(
      <DataTable<Row>
        rows={[{ id: '1', image: 'img', name: 'Dimmer', sku: 'D-1' }]}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Image', cell: (r) => r.image, mobile: 'media' },
          { header: 'Name', cell: (r) => r.name },
          { header: 'SKU', cell: (r) => r.sku },
        ]}
        empty={null}
      />,
    )
    const [image, name, sku] = screen.getAllByRole('cell')
    // The first column that is not media is the card's title: no label.
    expect(image).not.toHaveAttribute('data-label')
    expect(name).not.toHaveAttribute('data-label')
    expect(sku).toHaveAttribute('data-label', 'SKU')
    expect(sku).toHaveTextContent(/^D-1$/)
    // Explicit roles: they survive the display changes of the phone cards.
    expect(screen.getByRole('table')).toHaveAttribute('role', 'table')
    expect(screen.getAllByRole('rowgroup').map((g) => g.getAttribute('role'))).toEqual(['rowgroup', 'rowgroup'])
    expect(screen.getAllByRole('row').every((r) => r.getAttribute('role') === 'row')).toBe(true)
    expect(screen.getByRole('columnheader', { name: 'SKU' })).toHaveAttribute('role', 'columnheader')
    expect(sku).toHaveAttribute('role', 'cell')
  })
})
