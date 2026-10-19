import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { VersionNeeds } from '@/api/generated/model'
import i18n from '@/i18n'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { NeedsTab } from './NeedsTab'
import { emptyNeeds, needsSummary, versionId } from './test-fixtures'

function serve(data: VersionNeeds) {
  server.use(http.get('/api/versions/:versionId/needs', () => HttpResponse.json(data)))
}

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))

describe('NeedsTab', () => {
  it('lists the needs by plan and zone in plain words, with symbols marked and the API totals', async () => {
    serve(needsSummary)
    renderWithProviders(<NeedsTab versionId={versionId} />)

    expect(await screen.findByRole('heading', { name: 'Needs by room' })).toBeInTheDocument()
    expect(screen.getByText('All plans: 6 units · 22.5 W')).toBeInTheDocument()

    const plan = screen.getByRole('region', { name: 'Ground floor' })
    expect(within(plan).getByText('6 units · 22.5 W')).toBeInTheDocument()
    const living = within(plan).getByRole('list', { name: 'Living room' })
    const lines = within(living).getAllByRole('listitem')
    expect(lines[0]).toHaveTextContent('3 × Dimmable light · 7.5 W · LED · Ceiling')
    expect(lines[0]).toHaveTextContent('Warm white')
    expect(within(lines[0]).queryByText('Symbol on plan')).not.toBeInTheDocument()
    expect(lines[1]).toHaveTextContent('1 × Blind')
    expect(within(lines[1]).getByText('Symbol on plan')).toBeInTheDocument()
    expect(within(plan).getByText('4 units · 22.5 W')).toBeInTheDocument()

    const none = within(plan).getByRole('list', { name: 'No zone' })
    expect(within(none).getByRole('listitem')).toHaveTextContent('2 × Blind · Terrace')
    expect(within(plan).getByText('2 units')).toBeInTheDocument()

    expect(cells(screen.getByRole('table', { name: 'Totals by function type' }))).toEqual([
      ['Blind', '3', ''],
      ['Dimmable light', '3', '22.5 W'],
    ])
    expect(cells(screen.getByRole('table', { name: 'Totals by load type' }))).toEqual([
      ['LED', '3', '22.5 W'],
      ['No load type', '3', ''],
    ])
  })

  it('writes German names and decimals with a comma', async () => {
    await i18n.changeLanguage('de')
    try {
      serve(needsSummary)
      renderWithProviders(<NeedsTab versionId={versionId} />)
      expect(await screen.findByRole('heading', { name: 'Bedarf nach Raum' })).toBeInTheDocument()
      expect(screen.getByText('3 × Dimmbares Licht · 7,5 W · LED · Ceiling')).toBeInTheDocument()
      expect(screen.getByText('Alle Pläne: 6 Stück · 22,5 W')).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('shows the empty state without needs', async () => {
    serve(emptyNeeds)
    renderWithProviders(<NeedsTab versionId={versionId} />)
    expect(await screen.findByText('No needs planned yet: open a plan and add needs to its zones.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
