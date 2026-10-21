import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Readiness } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ReadinessSection } from './ReadinessSection'

const knxId = '00000000-0000-4000-8000-0000000000a1'
const zigbeeId = '00000000-0000-4000-8000-0000000000a2'
const product = (n: number) => ({ kind: 'product' as const, id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, label: { en: `A-${n}` } })

const readiness: Readiness = {
  systems: [
    {
      productTypeId: knxId,
      key: 'knx',
      name: { en: 'KNX' },
      abbreviation: 'KNX',
      topology: 'bus',
      items: [
        { code: 'system_no_enclosure', severity: 'info', count: 1, refs: [] },
        { code: 'product_board_without_width', severity: 'error', count: 22, refs: Array.from({ length: 20 }, (_, i) => product(i + 1)) },
        { code: 'system_no_power_supply', severity: 'warning', count: 1, refs: [] },
      ],
    },
    { productTypeId: zigbeeId, key: 'zigbee', name: { en: 'Zigbee' }, topology: 'wireless', items: [] },
  ],
  global: [
    { code: 'function_not_served', severity: 'error', count: 1, refs: [{ kind: 'function', id: '00000000-0000-4000-8000-0000000000f1', label: { en: 'Socket' } }] },
    { code: 'categories_without_mounting_board', severity: 'warning', count: 1, refs: [{ kind: 'category', id: '00000000-0000-4000-8000-0000000000c1', label: { en: 'Sensors' } }] },
  ],
}

describe('ReadinessSection', () => {
  it('shows a card per system and a General card, items grouped by severity with links', async () => {
    server.use(http.get('/api/catalog/readiness', () => HttpResponse.json(readiness)))
    renderWithProviders(<ReadinessSection />)
    expect(screen.getByText('What SnapFlow still needs before a system works in a project.')).toBeInTheDocument()
    const knx = await screen.findByRole('listitem', { name: 'KNX' })
    expect(within(knx).getByText('Bus')).toBeInTheDocument()
    // Errors, then warnings, then notes.
    expect(within(knx).getByRole('heading', { level: 3 })).toHaveTextContent('KNX')
    expect(within(knx).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Error', 'Warning', 'Note'])
    const width = knx.querySelector('[data-code="product_board_without_width"]') as HTMLElement
    expect(width).toHaveTextContent('Products on the board without a width (TE) (22)')
    expect(within(width).getAllByRole('link')).toHaveLength(20)
    expect(within(width).getByRole('link', { name: 'A-1' })).toHaveAttribute('href', `/catalog/products/${product(1).id}`)
    expect(width).toHaveTextContent('and 2 more')
    // A count of 1 is not shown.
    expect(knx.querySelector('[data-code="system_no_power_supply"]')).toHaveTextContent(/^No power supply: no product supplies bus current$/)

    expect(within(screen.getByRole('listitem', { name: 'Zigbee' })).getByText('Ready: nothing missing')).toBeInTheDocument()

    const general = screen.getByRole('listitem', { name: 'General' })
    expect(within(general).getByRole('link', { name: 'Socket' })).toHaveAttribute('href', '/catalog/function-types')
    expect(within(general).getByRole('link', { name: 'Sensors' })).toHaveAttribute('href', '/catalog/categories/00000000-0000-4000-8000-0000000000c1')
  })

  it('reads all green when nothing is missing', async () => {
    server.use(http.get('/api/catalog/readiness', () => HttpResponse.json({ systems: [{ ...readiness.systems[1] }], global: [] })))
    renderWithProviders(<ReadinessSection />)
    expect(await screen.findAllByText('Ready: nothing missing')).toHaveLength(2)
  })
})
