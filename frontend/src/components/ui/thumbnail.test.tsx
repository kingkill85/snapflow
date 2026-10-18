import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Thumbnail } from './thumbnail'

describe('Thumbnail', () => {
  it('shows the image, or a placeholder without one', () => {
    const { rerender } = render(<Thumbnail src="/api/files/1" alt="Dimmer" />)
    expect(screen.getByRole('img', { name: 'Dimmer' })).toHaveAttribute('src', '/api/files/1')

    rerender(<Thumbnail />)
    expect(screen.getByTestId('thumbnail-placeholder')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('falls back to the placeholder when the image fails, and tries a new one again', () => {
    const { rerender } = render(<Thumbnail src="/api/files/1" alt="Dimmer" />)
    fireEvent.error(screen.getByRole('img', { name: 'Dimmer' }))
    expect(screen.getByTestId('thumbnail-placeholder')).toBeInTheDocument()

    rerender(<Thumbnail src="/api/files/2" alt="Dimmer" />)
    expect(screen.getByRole('img', { name: 'Dimmer' })).toHaveAttribute('src', '/api/files/2')
  })
})
