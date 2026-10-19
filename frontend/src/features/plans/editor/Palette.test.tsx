import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { catalog, zigbeeId } from '../test-fixtures'
import { paletteProducts } from './catalog'
import { Palette } from './Palette'
import { productDragType } from './PlanCanvas'

const products = paletteProducts(catalog, [zigbeeId])

describe('Palette', () => {
  it('groups products by category with type badges, searches and arms a product', async () => {
    const onArm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<Palette products={products} armed={null} onArm={onArm} editable />)

    const switches = screen.getByRole('region', { name: 'Switches' })
    const wall = within(switches).getByRole('button', { name: /Wall switch/ })
    expect(within(wall).getByText('ZB')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Sensors' })).toBeInTheDocument()

    await user.click(wall)
    expect(onArm).toHaveBeenCalledWith(products[0].productId)

    await user.type(screen.getByLabelText('Search products'), 'motion')
    expect(screen.queryByRole('region', { name: 'Switches' })).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Search products'))
    await user.type(screen.getByLabelText('Search products'), 'xyz')
    expect(screen.getByText('No products match the search.')).toBeInTheDocument()
  })

  it('drags a product by its id and disarms on a second click', async () => {
    const onArm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<Palette products={products} armed={products[1].productId} onArm={onArm} editable />)
    const sensor = screen.getByRole('button', { name: /Motion sensor/ })
    expect(sensor).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Click on the plan to place the product/)).toBeInTheDocument()

    const setData = vi.fn()
    fireEvent.dragStart(sensor, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(productDragType, products[1].productId)

    await user.click(sensor)
    expect(onArm).toHaveBeenCalledWith(null)
  })

  it('is disabled while read-only and says when nothing can be placed', () => {
    const { unmount } = renderWithProviders(<Palette products={products} armed={null} onArm={() => undefined} editable={false} />)
    expect(screen.getByRole('button', { name: /Wall switch/ })).toBeDisabled()
    unmount()
    renderWithProviders(<Palette products={[]} armed={null} onArm={() => undefined} editable />)
    expect(screen.getByText("The project's product types have no available products.")).toBeInTheDocument()
  })
})
