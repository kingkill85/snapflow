import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { FileDrop } from './file-drop'

function Harness({ disabled, pending, progress, error }: { disabled?: boolean; pending?: boolean; progress?: number; error?: string }) {
  const [file, setFile] = useState<File>()
  return (
    <FileDrop
      label="File to import"
      file={file}
      onSelect={setFile}
      accept=".xlsx"
      required
      hint=".xlsx, at most 50 MB"
      error={error}
      disabled={disabled}
      pending={pending}
      progress={progress}
    />
  )
}

/** Drops files on the zone, as a browser's drag and drop does. */
function drop(files: File[]) {
  const zone = screen.getByTestId('file-drop-zone')
  const dataTransfer = { files }
  fireEvent.dragOver(zone, { dataTransfer })
  const event = createEvent.drop(zone, { dataTransfer })
  fireEvent(zone, event)
}

describe('FileDrop', () => {
  it('chooses a file with its button, which names the field, and announces it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByLabelText('File to import')
    expect(input).toBeRequired()
    expect(input).toHaveAccessibleDescription('.xlsx, at most 50 MB')
    const button = screen.getByRole('button', { name: 'Choose file (File to import)' })
    expect(button).toHaveAccessibleDescription('.xlsx, at most 50 MB')

    await user.upload(input, new File(['x'.repeat(2048)], 'supplier.xlsx'))
    expect(screen.getByText('supplier.xlsx')).toBeInTheDocument()
    expect(screen.getByText('(2 KB)')).toBeInTheDocument()
    expect(screen.getByText('Chosen: supplier.xlsx')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: 'Replace (File to import)' })).toBeInTheDocument()
  })

  it('takes a dropped file, but not while disabled', () => {
    const { unmount } = render(<Harness />)
    drop([new File(['x'], 'dropped.csv')])
    expect(screen.getByText('dropped.csv')).toBeInTheDocument()
    unmount()

    render(<Harness disabled />)
    drop([new File(['x'], 'ignored.csv')])
    expect(screen.queryByText('ignored.csv')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByLabelText('File to import')).toBeDisabled()
  })

  it('shows an upload in progress instead of the button, with or without a known progress', () => {
    const { rerender } = render(<Harness pending progress={0.42} />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading…' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<Harness pending />)
    expect(screen.getByRole('progressbar', { name: 'Uploading…' })).not.toHaveAttribute('aria-valuenow')
  })

  it('shows an error instead of the hint, announced and on the button', () => {
    render(<Harness error="Only .xlsx workbooks can be imported." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Only .xlsx workbooks can be imported.')
    const button = screen.getByRole('button', { name: 'Choose file (File to import)' })
    expect(button).toHaveAttribute('aria-invalid', 'true')
    expect(button).toHaveAccessibleDescription('Only .xlsx workbooks can be imported.')
  })
})
