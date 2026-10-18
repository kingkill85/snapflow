import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ImageUpload } from './image-upload'

describe('ImageUpload', () => {
  it('takes a dropped or chosen file', async () => {
    const onSelect = vi.fn()
    render(<ImageUpload label="Image" onSelect={onSelect} onRemove={vi.fn()} />)

    const file = new File(['x'], 'a.png', { type: 'image/png' })
    fireEvent.drop(screen.getByTestId('image-drop-zone'), { dataTransfer: { files: [file] } })
    await userEvent.upload(screen.getByLabelText('Image'), file)

    expect(onSelect.mock.calls).toEqual([[file], [file]])
    expect(screen.getByText('Drop an image here or choose a file.')).toBeInTheDocument()
  })

  it('shows the preview with Replace and Remove, the progress while uploading, and errors', async () => {
    const onRemove = vi.fn()
    const { rerender } = render(<ImageUpload label="Image" src="/api/files/1" onSelect={vi.fn()} onRemove={onRemove} />)

    expect(screen.getByRole('img', { name: 'Image' })).toHaveAttribute('src', '/api/files/1')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(onRemove).toHaveBeenCalled()

    rerender(<ImageUpload label="Image" pending progress={0.42} onSelect={vi.fn()} onRemove={onRemove} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<ImageUpload label="Image" error="Too large" onSelect={vi.fn()} onRemove={onRemove} />)
    expect(screen.getByLabelText('Image')).toHaveAccessibleDescription('Too large')

    rerender(<ImageUpload label="Image" disabled onSelect={vi.fn()} onRemove={onRemove} />)
    expect(screen.getByText('No image')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows an indeterminate progress when the percentage is unknown', () => {
    render(<ImageUpload label="Image" pending onSelect={vi.fn()} onRemove={vi.fn()} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('data-indeterminate', 'true')
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
  })

  it('marks the visible button, not the hidden file input, as invalid', () => {
    const { rerender } = render(<ImageUpload label="Image" src="/api/files/1" error="Too large" onSelect={vi.fn()} onRemove={vi.fn()} />)
    const replace = screen.getByRole('button', { name: 'Replace' })
    expect(replace).toHaveAttribute('aria-invalid', 'true')
    expect(replace).toHaveAccessibleDescription('Too large')
    expect(screen.getByLabelText('Image')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('alert')).not.toHaveAttribute('data-field-error')

    // Without a button (uploading), the message itself takes the focus.
    rerender(<ImageUpload label="Image" pending error="Too large" onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveAttribute('data-field-error', 'true')
    expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '-1')
  })

  it('falls back to the placeholder when the preview fails to load', () => {
    render(<ImageUpload label="Image" src="/api/files/1" onSelect={vi.fn()} onRemove={vi.fn()} />)
    fireEvent.error(screen.getByRole('img', { name: 'Image' }))
    expect(screen.queryByRole('img', { name: 'Image' })).not.toBeInTheDocument()
    // Still set: it can be replaced or removed.
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
  })
})
