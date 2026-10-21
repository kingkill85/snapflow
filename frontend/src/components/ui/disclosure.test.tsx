import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { Disclosure } from './disclosure'

describe('Disclosure', () => {
  it('starts collapsed, keeps the content mounted, and toggles', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Disclosure title="Advanced" description="Voltage and reserve">
        <label>
          Reserve <input defaultValue="20" />
        </label>
      </Disclosure>,
    )
    const toggle = screen.getByRole('button', { name: /Advanced/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Voltage and reserve')).toBeVisible()
    // Hidden but mounted: the field keeps its value.
    expect(screen.getByLabelText('Reserve', { selector: 'input' })).not.toBeVisible()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: 'Advanced' })).toBeVisible()
    expect(screen.getByLabelText('Reserve', { selector: 'input' })).toHaveValue('20')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderWithProviders(
      <Disclosure title="Details" open onOpenChange={onOpenChange}>
        content
      </Disclosure>,
    )
    expect(screen.getByText('content')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
