import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { CalibrateDialog } from './CalibrateDialog'

const points: [{ x: number; y: number }, { x: number; y: number }] = [
  { x: 0, y: 0 },
  { x: 60, y: 80 },
]

describe('CalibrateDialog', () => {
  it('asks for the real distance and sets the scale in metres per pixel', async () => {
    const onScale = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<CalibrateDialog points={points} onClose={onClose} onScale={onScale} />)

    const dialog = screen.getByRole('dialog', { name: 'Calibrate scale' })
    expect(dialog).toHaveTextContent('100 px apart')
    await user.type(screen.getByLabelText(/Real distance/), 'abc')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByText('Enter a distance above 0 in metres.')).toBeInTheDocument()
    expect(onScale).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText(/Real distance/))
    await user.type(screen.getByLabelText(/Real distance/), '2,5')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onScale).toHaveBeenCalledWith(0.025)
    expect(onClose).toHaveBeenCalled()
  })

  it('is closed without points and Cancel closes it', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { rerender } = renderWithProviders(<CalibrateDialog points={null} onClose={onClose} onScale={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<CalibrateDialog points={points} onClose={onClose} onScale={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
