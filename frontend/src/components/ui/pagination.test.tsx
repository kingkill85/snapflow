import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Pagination } from './pagination'
import { lastPageOffset } from './paging'

describe('Pagination', () => {
  it('shows the range and pages with Previous and Next', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<Pagination offset={0} limit={50} total={120} onChange={onChange} />)

    expect(screen.getByText('1–50 of 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(onChange).toHaveBeenLastCalledWith(50)

    rerender(<Pagination offset={100} limit={50} total={120} onChange={onChange} />)
    expect(screen.getByText('101–120 of 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Previous/ }))
    expect(onChange).toHaveBeenLastCalledWith(50)
  })

  it.each([
    [0, 0],
    [120, 120],
    [150, 120],
  ])('renders nothing at offset %i of %i rows', (offset, total) => {
    const { container } = render(<Pagination offset={offset} limit={50} total={total} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('finds the offset of the last page', () => {
    expect(lastPageOffset(0, 50)).toBe(0)
    expect(lastPageOffset(50, 50)).toBe(0)
    expect(lastPageOffset(51, 50)).toBe(50)
    expect(lastPageOffset(120, 50)).toBe(100)
  })
})
