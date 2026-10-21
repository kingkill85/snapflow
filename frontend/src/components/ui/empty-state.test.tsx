import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { Button } from './button'
import { EmptyState } from './page'

describe('EmptyState', () => {
  it('shows the text and the action that fixes it', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderWithProviders(<EmptyState title="No systems yet." action={<Button onClick={onClick}>Choose systems</Button>} />)
    expect(screen.getByText('No systems yet.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Choose systems' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows an icon before the text and no action slot without one', () => {
    const { container } = renderWithProviders(<EmptyState title="No problems found." icon={<svg data-testid="icon" />} />)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByText('No problems found.')).toBeVisible()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
