import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { PlanZone } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'

import { catalog, placement, pid, zigbeeId } from '../test-fixtures'
import { paletteProducts } from './catalog'
import { allVisible, type Layers } from './layers'
import { LayersPanel } from './LayersPanel'
import { ZonesPanel } from './ZonesPanel'

const zone = (n: number, x: number, over: Partial<PlanZone> = {}): PlanZone => ({
  id: pid(950 + n),
  name: `Zone ${n}`,
  color: '#3b82f6',
  opacity: 0.25,
  points: [
    [x, 0],
    [x + 150, 0],
    [x + 150, 200],
    [x, 200],
  ],
  ...over,
})

// Zone 1 covers x 0–150, zone 2 x 150–300 (placements sit at x = 100 n, y = 100).
const zones = [zone(1, 0), zone(2, 150)]
const saved = [placement(1, { zoneId: zones[0].id }), placement(2, { zoneId: zones[0].id })]
const now = [placement(1), placement(2)]

describe('ZonesPanel', () => {
  it('says when there are no zones', () => {
    renderWithProviders(<ZonesPanel zones={[]} saved={[]} placements={[]} selection={[]} layers={allVisible()} onLayers={vi.fn()} onSelect={vi.fn()} />)
    expect(screen.getByText('No zones yet.')).toBeInTheDocument()
  })

  it('lists zones with saved counts and a live estimate when they differ; a click selects', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<ZonesPanel zones={zones} saved={saved} placements={now} selection={[]} layers={allVisible()} onLayers={vi.fn()} onSelect={onSelect} />)

    expect(screen.getByTestId(`zone-count-${zones[0].id}`)).toHaveTextContent('2 devices(now ≈ 1)')
    expect(screen.getByTestId(`zone-count-${zones[1].id}`)).toHaveTextContent('0 devices(now ≈ 1)')
    await user.click(screen.getByRole('button', { name: 'Zone 2' }))
    expect(onSelect).toHaveBeenCalledWith(zones[1].id)
  })

  it('shows no estimate when it matches the saved count', () => {
    renderWithProviders(<ZonesPanel zones={zones} saved={saved} placements={[placement(1)]} selection={[]} layers={allVisible()} onLayers={vi.fn()} onSelect={vi.fn()} />)
    expect(screen.getByTestId(`zone-count-${zones[1].id}`)).toHaveTextContent(/^0 devices$/)
  })

  it('hides and shows single zones and all zones', async () => {
    const onLayers = vi.fn()
    const user = userEvent.setup()
    const { rerender } = renderWithProviders(<ZonesPanel zones={zones} saved={[]} placements={[]} selection={[]} layers={allVisible()} onLayers={onLayers} onSelect={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Hide Zone 1' }))
    let layers = onLayers.mock.calls.at(-1)?.[0] as Layers
    expect([...layers.hiddenZones]).toEqual([zones[0].id])
    expect(layers.zonesHidden).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Hide all' }))
    layers = onLayers.mock.calls.at(-1)?.[0] as Layers
    expect(layers.zonesHidden).toBe(true)
    expect(layers.hiddenZones.size).toBe(0)

    // With all hidden: showing one hides only the others; "Show all" shows everything.
    rerender(<ZonesPanel zones={zones} saved={[]} placements={[]} selection={[]} layers={{ ...allVisible(), zonesHidden: true }} onLayers={onLayers} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Zone 1' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Show Zone 1' }))
    layers = onLayers.mock.calls.at(-1)?.[0] as Layers
    expect(layers.zonesHidden).toBe(false)
    expect([...layers.hiddenZones]).toEqual([zones[1].id])
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    layers = onLayers.mock.calls.at(-1)?.[0] as Layers
    expect(layers.zonesHidden).toBe(false)
    expect(layers.hiddenZones.size).toBe(0)
  })
})

const lastLayers = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as Layers

describe('LayersPanel', () => {
  it('toggles zones, product types and categories', async () => {
    const onLayers = vi.fn()
    const user = userEvent.setup()
    const variants = new Map(catalog.map((v) => [v.id, v]))
    // A placed KNX switch (not in the palette) adds its type.
    const placed = [placement(1, { variantId: catalog[3].id })]
    renderWithProviders(<LayersPanel placements={placed} products={paletteProducts(catalog, [zigbeeId])} variants={variants} layers={allVisible()} onLayers={onLayers} />)

    await user.click(screen.getByRole('switch', { name: 'Zones' }))
    expect(lastLayers(onLayers).zonesHidden).toBe(true)

    const types = screen.getByRole('group', { name: 'Product types' })
    expect(within(types).getAllByRole('switch')).toHaveLength(2)
    await user.click(within(types).getByRole('switch', { name: 'KNX' }))
    expect([...lastLayers(onLayers).hiddenProductTypes]).toEqual([catalog[3].productTypeId])

    const categories = screen.getByRole('group', { name: 'Categories' })
    await user.click(within(categories).getByRole('switch', { name: 'Sensors' }))
    expect([...lastLayers(onLayers).hiddenCategories]).toEqual([catalog[2].categoryId])
  })

  it('shows hidden layers switched off and switches them back on', async () => {
    const onLayers = vi.fn()
    const user = userEvent.setup()
    const variants = new Map(catalog.map((v) => [v.id, v]))
    const layers = { ...allVisible(), hiddenCategories: new Set([catalog[2].categoryId]) }
    renderWithProviders(<LayersPanel placements={[]} products={paletteProducts(catalog, [zigbeeId])} variants={variants} layers={layers} onLayers={onLayers} />)
    const sensors = screen.getByRole('switch', { name: 'Sensors' })
    expect(sensors).not.toBeChecked()
    await user.click(sensors)
    expect(lastLayers(onLayers).hiddenCategories.size).toBe(0)
  })
})
