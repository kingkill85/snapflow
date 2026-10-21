import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge } from './badge'

describe('Badge', () => {
  it('stays on one line by default', () => {
    render(<Badge>3 × Light</Badge>)
    const badge = screen.getByText('3 × Light')
    expect(badge).toHaveClass('whitespace-nowrap')
    expect(badge).not.toHaveClass('whitespace-normal')
  })

  it('wraps long texts within its container with wrap', () => {
    render(<Badge wrap>8 × Dimmable light · 5.5 W · Ceiling spots along the window front</Badge>)
    const badge = screen.getByText(/Ceiling spots/)
    expect(badge).toHaveClass('whitespace-normal', 'max-w-full')
    expect(badge).not.toHaveClass('whitespace-nowrap')
  })
})
