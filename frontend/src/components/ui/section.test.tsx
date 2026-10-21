import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { Section, SectionGroup } from './section'

describe('SectionGroup', () => {
  it('names its region and puts the sections inside one heading level lower', () => {
    renderWithProviders(
      <>
        <Section title="Alone">x</Section>
        <SectionGroup title="For the customer" description="Proposals with prices.">
          <Section title="Proposals">y</Section>
        </SectionGroup>
      </>,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Alone' })).toBeInTheDocument()
    const group = screen.getByRole('region', { name: 'For the customer' })
    expect(group).toHaveTextContent('Proposals with prices.')
    expect(screen.getByRole('heading', { level: 3, name: 'Proposals' })).toBeInTheDocument()
  })
})
