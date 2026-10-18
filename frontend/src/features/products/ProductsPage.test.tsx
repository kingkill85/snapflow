import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProductListItem } from '@/api/generated/model'
import i18n from '@/i18n'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { chooseOption, optionTexts } from '@/test/select'

import { ProductEditorPage } from './ProductEditorPage'
import { ProductsPage } from './ProductsPage'
import { categories, dimmer, gatewayCategory, ids, inactiveCategory, knxType, legacyType, listItem, types, zigbeeType } from './test-fixtures'

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
    http.get('/api/categories', () => HttpResponse.json({ items: categories })),
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

  it('lists products with image, type, category, variant count, price range, status and problems', async () => {
    listHandlers(() => [
      listItem(),
      listItem({
        id: ids.id(202),
        modelNumber: 'GW-1',
        name: { en: 'Gateway' },
        productTypeId: knxType.id,
        productType: { id: knxType.id, key: knxType.key, name: knxType.name, isActive: true },
        categoryId: gatewayCategory.id,
        category: { id: gatewayCategory.id, key: gatewayCategory.key, name: gatewayCategory.name, isActive: true },
        priceMin: '99.50',
        priceMax: '99.50',
        previewImageFileId: undefined,
      }),
      listItem({ id: ids.id(203), modelNumber: 'OLD-1', isActive: false, available: false, variantCount: 0, priceMin: undefined, priceMax: undefined }),
      listItem({ id: ids.id(204), modelNumber: 'TYPE-OFF', available: false, attributeErrors: 2, staleAttributes: 1 }),
    ])
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    const first = (await screen.findByRole('link', { name: 'M485/DIM.4' })).closest('tr')!
    // Decorative (alt=""): the row names the product.
    expect(first.querySelector('img')).toHaveAttribute('src', `/api/files/${ids.id(901)}`)
    expect(first).toHaveTextContent('Dimmer 4ch')
    // The product type with its badge (abbreviation on its colour, text for contrast), and the category.
    const cells = within(first).getAllByRole('cell')
    expect(cells[3]).toHaveTextContent('ZBZigbee')
    expect(within(cells[3]).getByTestId('type-abbreviation')).toHaveStyle({ backgroundColor: '#1f6feb', color: '#ffffff' })
    expect(cells[4]).toHaveTextContent('Dimmer actuators')
    expect(first).toHaveTextContent('$27.00 – $35.00')
    expect(first).toHaveTextContent('Active')
    expect(first).not.toHaveTextContent('attention')

    const gateway = row('GW-1')
    expect(gateway).toHaveTextContent('$99.50')
    expect(gateway).not.toHaveTextContent('–')
    expect(gateway.querySelector('img')).toBeNull()
    // A type without abbreviation shows a dot; without colour it is outlined.
    expect(within(gateway).getByTestId('type-color')).not.toHaveAttribute('style')
    expect(gateway).toHaveTextContent('KNX')
    expect(gateway).toHaveTextContent('Gateways')
    expect(within(gateway).getByTestId('thumbnail-placeholder')).toBeInTheDocument()

    const old = row('OLD-1')
    expect(old).toHaveTextContent('Inactive')
    expect(old).toHaveTextContent('–')

    // Active, but its type or category is not: unavailable, with the reason; three values need attention.
    const typeOff = row('TYPE-OFF')
    expect(within(typeOff).getByTitle('Active, but its product type or category is inactive.')).toHaveTextContent('Unavailable')
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
    // Nothing more arrives once typing stopped.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(requests.length).toBe(before + 1)
    expect(screen.getByLabelText('Search')).toHaveAttribute('maxlength', '200')

    // Inactive types are offered too.
    const typeSelect = screen.getByLabelText('Product type')
    expect(await optionTexts(u, typeSelect)).toEqual(['All product types', 'ZBZigbee', 'KNX', 'Legacy (inactive)'])
    await chooseOption(u, typeSelect, 'KNX')
    await waitFor(() => expect(last()).toEqual({ search: 'dim 4', productTypeId: knxType.id, limit: '50', offset: '0' }))

    // So are inactive categories; both filters together.
    const categorySelect = screen.getByLabelText('Category')
    expect(await optionTexts(u, categorySelect)).toEqual(['All categories', 'Dimmer actuators', 'Gateways', 'Retired (inactive)'])
    await chooseOption(u, categorySelect, 'Gateways')
    await waitFor(() =>
      expect(last()).toEqual({ search: 'dim 4', productTypeId: knxType.id, categoryId: gatewayCategory.id, limit: '50', offset: '0' }),
    )

    await u.click(screen.getByLabelText('Show inactive'))
    await waitFor(() =>
      expect(last()).toEqual({
        search: 'dim 4',
        productTypeId: knxType.id,
        categoryId: gatewayCategory.id,
        includeInactive: 'true',
        limit: '50',
        offset: '0',
      }),
    )

    await chooseOption(u, typeSelect, 'All product types')
    await chooseOption(u, categorySelect, 'All categories')
    await waitFor(() => expect(last()).toEqual({ search: 'dim 4', includeInactive: 'true', limit: '50', offset: '0' }))
  })

  it('shows a changed filter at once, not only when the navigation has finished', async () => {
    listHandlers(
      () => [listItem()],
      () => 1,
    )
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })
    const checkbox = await screen.findByLabelText('Show inactive')
    const typeSelect = screen.getByLabelText('Product type')
    await userEvent.setup().click(typeSelect)
    const knx = await screen.findByRole('option', { name: 'KNX' })

    // Not through act(), which would finish the navigation first: what the
    // user sees right after the click.
    checkbox.click()
    expect(checkbox).toBeChecked()
    knx.click()
    expect(typeSelect).toHaveTextContent('KNX')
    await waitFor(() => expect(checkbox).toBeChecked())
  })

  it('pages with Previous and Next, showing where the page is', async () => {
    const { last } = listHandlers(
      () => [listItem()],
      () => 120,
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: `/catalog/products?type=${zigbeeType.id}` })

    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument()
    expect(last()).toEqual({ productTypeId: zigbeeType.id, limit: '50', offset: '0' })
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()

    await u.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('101–120 of 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled()
    expect(last()).toEqual({ productTypeId: zigbeeType.id, limit: '50', offset: '100' })

    await u.click(screen.getByRole('button', { name: /Previous/ }))
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
  })

  it('moves to the last page when the URL points past the end', async () => {
    const { last, requests } = listHandlers(
      () => [listItem()],
      () => 120,
    )
    const { router } = renderRoutes(routes, { me: adminMe, route: '/catalog/products?offset=500' })

    expect(await screen.findByText('101–120 of 120')).toBeInTheDocument()
    await waitFor(() => expect(last()).toEqual({ limit: '50', offset: '100' }))
    expect(router.state.location.search).toBe('?offset=100')
    // Replaced, so Back does not return to the empty page.
    expect(router.state.historyAction).toBe('REPLACE')
    // The page past the end never showed a range.
    expect(requests.map((r) => r.get('offset'))).toEqual(['500', '100'])
  })

  it('moves to the previous page after deleting the last row of the last page', async () => {
    let total = 51
    listHandlers(
      () => [listItem()],
      () => total,
    )
    server.use(
      http.delete('/api/products/:id', () => {
        total = 50
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products?offset=50' })

    expect(await screen.findByText('51–51 of 51')).toBeInTheDocument()
    await u.click(within(row('M485/DIM.4')).getByRole('button', { name: 'Delete' }))
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete product' })).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('1–50 of 50')).toBeInTheDocument()
    expect(screen.queryByText(/51–50/)).not.toBeInTheDocument()
  })

  it('shows the search of the URL when it changes from outside, e.g. the navigation link to the bare list', async () => {
    listHandlers()
    const u = userEvent.setup()
    const { router } = renderRoutes(routes, { me: adminMe, route: '/catalog/products?search=dim' })

    expect(await screen.findByLabelText('Search')).toHaveValue('dim')
    await u.type(screen.getByLabelText('Search'), 'mer')
    await waitFor(() => expect(router.state.location.search).toBe('?search=dimmer'))

    await act(() => router.navigate('/catalog/products'))
    await waitFor(() => expect(screen.getByLabelText('Search')).toHaveValue(''))
    // And it stays cleared: the old text is not searched again.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(router.state.location.search).toBe('')

    await act(() => router.navigate('/catalog/products?search=gw'))
    await waitFor(() => expect(screen.getByLabelText('Search')).toHaveValue('gw'))
  })

  it('shows inactive products when an inactive type or category is chosen', async () => {
    const { last } = listHandlers()
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products' })

    await screen.findByRole('link', { name: 'M485/DIM.4' })
    expect(screen.getByLabelText('Show inactive')).not.toBeChecked()
    await chooseOption(u, screen.getByLabelText('Product type'), 'Legacy (inactive)')

    await waitFor(() => expect(last()).toEqual({ productTypeId: legacyType.id, includeInactive: 'true', limit: '50', offset: '0' }))
    expect(screen.getByLabelText('Show inactive')).toBeChecked()

    // An active type leaves the checkbox as it is.
    await chooseOption(u, screen.getByLabelText('Product type'), 'Zigbee')
    await waitFor(() => expect(last()).toEqual({ productTypeId: zigbeeType.id, includeInactive: 'true', limit: '50', offset: '0' }))

    // Likewise for categories.
    await u.click(screen.getByLabelText('Show inactive'))
    await waitFor(() => expect(screen.getByLabelText('Show inactive')).not.toBeChecked())
    await chooseOption(u, screen.getByLabelText('Category'), 'Retired (inactive)')
    await waitFor(() =>
      expect(last()).toEqual({ productTypeId: zigbeeType.id, categoryId: inactiveCategory.id, includeInactive: 'true', limit: '50', offset: '0' }),
    )
    expect(screen.getByLabelText('Show inactive')).toBeChecked()
  })

  it('returns to the filtered list from a product, with Back to list and with Cancel', async () => {
    const { last } = listHandlers(
      () => [listItem()],
      () => 120,
    )
    server.use(http.get('/api/products/:id', () => HttpResponse.json(dimmer)))
    const u = userEvent.setup()
    const editorRoutes = [
      { path: '/catalog/products', element: <ProductsPage /> },
      { path: '/catalog/products/:id', element: <ProductEditorPage /> },
    ]
    const filters = `?search=dim&type=${zigbeeType.id}&offset=50`
    const { router } = renderRoutes(editorRoutes, { me: adminMe, route: `/catalog/products${filters}` })

    await u.click(await screen.findByRole('link', { name: 'M485/DIM.4' }))
    await u.click(await screen.findByRole('link', { name: 'Back to list' }))

    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
    expect(router.state.location.search).toBe(filters)
    expect(screen.getByLabelText('Search')).toHaveValue('dim')
    expect(last()).toEqual({ search: 'dim', productTypeId: zigbeeType.id, limit: '50', offset: '50' })

    await u.click(screen.getByRole('link', { name: 'M485/DIM.4' }))
    await u.type(await screen.findByLabelText('Name (German)'), ' neu')
    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    await u.click(within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Leave page' }))

    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
    expect(router.state.location.search).toBe(filters)
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
