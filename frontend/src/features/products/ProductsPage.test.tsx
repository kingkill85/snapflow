import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProductListItem } from '@/api/generated/model'
import i18n from '@/i18n'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { ProductsPage } from './ProductsPage'
import { dimmer, dimmerType, gatewayType, ids, listItem, types } from './test-fixtures'

const routes = [
  { path: '/catalog/products', element: <ProductsPage /> },
  { path: '/catalog/products/:id', element: <p>product page</p> },
  { path: '/catalog/products/new', element: <p>new product page</p> },
]

/** Answers the list with `items` (and `total`), recording each request's query. */
function listHandlers(items: () => ProductListItem[] = () => [listItem()], total?: () => number) {
  const requests: URLSearchParams[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: types })),
    http.get('/api/products', ({ request }) => {
      requests.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items: items(), total: total?.() ?? items().length })
    }),
  )
  /** The query of the last request, as a plain object. */
  const last = () => Object.fromEntries(requests[requests.length - 1])
  return { requests, last }
}

const row = (name: string) => screen.getByRole('link', { name }).closest('tr')!

describe('ProductsPage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('lists products with image, type, variant count, price range, status and problems', async () => {
    listHandlers(() => [
      listItem(),
      listItem({ id: ids.id(202), modelNumber: 'GW-1', name: { en: 'Gateway' }, priceMin: '99.50', priceMax: '99.50', previewImageFileId: undefined }),
      listItem({ id: ids.id(203), modelNumber: 'OLD-1', isActive: false, available: false, variantCount: 0, priceMin: undefined, priceMax: undefined }),
      listItem({ id: ids.id(204), modelNumber: 'TYPE-OFF', available: false, attributeErrors: 2, staleAttributes: 1 }),
    ])
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    const first = (await screen.findByRole('link', { name: 'M485/DIM.4' })).closest('tr')!
    // Decorative (alt=""): the row names the product.
    expect(first.querySelector('img')).toHaveAttribute('src', `/api/files/${ids.id(901)}`)
    expect(first).toHaveTextContent('Dimmer 4ch')
    expect(first).toHaveTextContent('Dimmer actuator')
    expect(within(first).getByTestId('type-color')).toHaveStyle({ backgroundColor: '#1f6feb' })
    expect(first).toHaveTextContent('$27.00 – $35.00')
    expect(first).toHaveTextContent('Active')
    expect(first).not.toHaveTextContent('attention')

    const gateway = row('GW-1')
    expect(gateway).toHaveTextContent('$99.50')
    expect(gateway).not.toHaveTextContent('–')
    expect(gateway.querySelector('img')).toBeNull()
    expect(within(gateway).getByTestId('thumbnail-placeholder')).toBeInTheDocument()

    const old = row('OLD-1')
    expect(old).toHaveTextContent('Inactive')
    expect(old).toHaveTextContent('–')

    // Active, but its type is not: unavailable, with the reason; three values need attention.
    const typeOff = row('TYPE-OFF')
    expect(within(typeOff).getByTitle('Active, but its product type is inactive.')).toHaveTextContent('Unavailable')
    expect(within(typeOff).getByTitle('3 attribute values need attention')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: 'New product' })).toHaveAttribute('href', '/catalog/products/new')
    expect(within(first).getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}`)
  })

  it('formats prices for the UI language', async () => {
    await i18n.changeLanguage('de')
    listHandlers()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    const first = (await screen.findByRole('link', { name: 'M485/DIM.4' })).closest('tr')!
    expect(first.textContent?.replace(/\s/g, ' ')).toContain('27,00 $ – 35,00 $')
    expect(first).toHaveTextContent('Aktiv')
  })

  it('sends search, type and "show inactive" as query parameters, starting again at the first page', async () => {
    const { last, requests } = listHandlers(
      () => [listItem()],
      () => 120,
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    await screen.findByRole('link', { name: 'M485/DIM.4' })
    expect(last()).toEqual({ limit: '50', offset: '0' })

    await u.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(last()).toEqual({ limit: '50', offset: '50' }))

    // Typing is debounced: one request for the whole word.
    const before = requests.length
    await u.type(screen.getByLabelText('Search'), 'dim 4')
    await waitFor(() => expect(last()).toEqual({ search: 'dim 4', limit: '50', offset: '0' }))
    expect(requests.length).toBe(before + 1)

    // Inactive types are offered too.
    const typeSelect = screen.getByLabelText('Product type')
    expect(within(typeSelect).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All product types',
      'Dimmer actuator',
      'Gateway',
      'Legacy (inactive)',
    ])
    await u.selectOptions(typeSelect, gatewayType.id)
    await waitFor(() => expect(last()).toEqual({ search: 'dim 4', productTypeId: gatewayType.id, limit: '50', offset: '0' }))

    await u.click(screen.getByLabelText('Show inactive'))
    await waitFor(() =>
      expect(last()).toEqual({ search: 'dim 4', productTypeId: gatewayType.id, includeInactive: 'true', limit: '50', offset: '0' }),
    )

    await u.selectOptions(typeSelect, '')
    await waitFor(() => expect(last()).toEqual({ search: 'dim 4', includeInactive: 'true', limit: '50', offset: '0' }))
  })

  it('pages with Previous and Next, showing where the page is', async () => {
    const { last } = listHandlers(
      () => [listItem()],
      () => 120,
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: `/catalog/products?type=${dimmerType.id}` })

    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument()
    expect(last()).toEqual({ productTypeId: dimmerType.id, limit: '50', offset: '0' })
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()

    await u.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('101–120 of 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled()
    expect(last()).toEqual({ productTypeId: dimmerType.id, limit: '50', offset: '100' })

    await u.click(screen.getByRole('button', { name: /Previous/ }))
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
  })

  it('opens a product from its model number', async () => {
    listHandlers()
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    await u.click(await screen.findByRole('link', { name: 'M485/DIM.4' }))

    expect(await screen.findByText('product page')).toBeInTheDocument()
  })

  it('deletes a product after confirming', async () => {
    let items = [listItem()]
    let deleted = ''
    listHandlers(() => items)
    server.use(
      http.delete('/api/products/:id', ({ params }) => {
        deleted = String(params.id)
        items = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    await screen.findByRole('link', { name: 'M485/DIM.4' })
    await u.click(within(row('M485/DIM.4')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete product' })
    expect(dialog).toHaveTextContent('Delete "M485/DIM.4 Dimmer 4ch" with all its variants and add-on links?')
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('No products yet.')).toBeInTheDocument()
    expect(deleted).toBe(dimmer.id)
  })

  it('shows the list read-only without catalog.write', async () => {
    listHandlers(() => [listItem({ can: { update: false, delete: false } })])
    renderRoutes(routes, { me: userMe, route: '/catalog/products' })

    expect(await screen.findByRole('link', { name: 'M485/DIM.4' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New product' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('tells an empty catalog from filters that match nothing', async () => {
    listHandlers(() => [])
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    expect(await screen.findByText('No products yet.')).toBeInTheDocument()
    await u.type(screen.getByLabelText('Search'), 'xyz')
    expect(await screen.findByText('No products match these filters.')).toBeInTheDocument()
  })
})
