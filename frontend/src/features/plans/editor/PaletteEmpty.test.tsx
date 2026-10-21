import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { currencies, productTypes, tenants, villa } from '@/features/projects/test-fixtures'
import { adminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { PaletteEmpty } from './PaletteEmpty'

const noSystems = { ...villa, productTypeIds: [] }

describe('PaletteEmpty', () => {
  it('without systems offers "Choose systems": the project dialog opens with the systems field focused', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: tenants })),
      http.get('/api/product-types', () => HttpResponse.json({ items: productTypes })),
      http.get('/api/currencies', () => HttpResponse.json(currencies)),
    )
    renderWithProviders(<PaletteEmpty project={noSystems} kind="floorplan" />)
    expect(screen.getByText('This project has no systems yet. Choose the systems you plan with to see their products.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Choose systems' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' })
    await waitFor(() => expect(dialog.querySelector('fieldset input')).toHaveFocus())
  })

  it('without systems shows only the text to who may not change the project', () => {
    renderWithProviders(<PaletteEmpty project={{ ...noSystems, can: { ...villa.can, update: false } }} kind="board" />)
    expect(screen.getByText(/This project has no systems yet/)).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('with systems but nothing for this plan kind links to the catalog', () => {
    renderWithProviders(<PaletteEmpty project={villa} kind="board" />, { me: adminMe })
    expect(screen.getByText("No products of the project's systems go on a board.")).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open the catalog' })).toHaveAttribute('href', '/catalog/products')
  })

  it('names the floorplan and leaves out the catalog link without catalog.read', () => {
    renderWithProviders(<PaletteEmpty project={villa} kind="floorplan" />, { me: { ...userMe, permissions: userMe.permissions.filter((p) => p !== 'catalog.read') } })
    expect(screen.getByText("No products of the project's systems go on a floorplan.")).toBeVisible()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
