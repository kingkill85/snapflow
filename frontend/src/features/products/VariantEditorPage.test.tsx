import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AddonList, Product, Variant, VariantInput, VariantSearchItem, VariantUpdate } from '@/api/generated/model'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { shownTranslation, translation } from '@/test/translatable'
import { chooseOption, optionTexts } from '@/test/select'

import { black, categories, dimmer, gatewayCategory, ids, ivory, knxType, problem, types } from './test-fixtures'
import { VariantEditorPage } from './VariantEditorPage'

const routes = [
  { path: '/catalog/products/:id', element: <p>product page</p> },
  { path: '/catalog/products/:id/variants/new', element: <VariantEditorPage /> },
  { path: '/catalog/products/:id/variants/:variantId', element: <VariantEditorPage /> },
]
const newRoute = `/catalog/products/${dimmer.id}/variants/new`
const ivoryRoute = `/catalog/products/${dimmer.id}/variants/${ivory.id}`
const uploadedId = ids.id(902)

const region = (name: string) => screen.getByRole('region', { name })

/**
 * GET product returns `product()`, PUT variant records and answers with
 * `respond` (default: the variant); the add-on picker browses an empty catalog.
 */
function handlers(product: () => Product = () => dimmer, respond?: () => Response) {
  const puts: VariantUpdate[] = []
  const uploads: { name: string; type: string }[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: types })),
    http.get('/api/categories', () => HttpResponse.json({ items: categories })),
    http.get('/api/variants', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/products/:id', () => HttpResponse.json(product())),
    http.put('/api/products/:id/variants/:variantId', async ({ request }) => {
      puts.push((await request.json()) as VariantUpdate)
      return respond ? respond() : HttpResponse.json(product().variants[0])
    }),
    http.post('/api/files', async ({ request }) => {
      const file = (await request.formData()).get('file') as File
      uploads.push({ name: file.name, type: file.type })
      return HttpResponse.json(
        { id: uploadedId, url: `/api/files/${uploadedId}`, contentType: file.type, size: 3, sha256: 'ab', createdAt: '2026-01-01T00:00:00Z' },
        { status: 201 },
      )
    }),
  )
  return { puts, uploads }
}

const searchItem = (n: number, overrides: Partial<VariantSearchItem> = {}): VariantSearchItem => ({
  id: ids.id(n),
  productId: ids.id(n + 100),
  productTypeId: dimmer.productTypeId,
  productType: dimmer.productType,
  categoryId: dimmer.categoryId,
  category: dimmer.category,
  modelNumber: `ACC-${n}`,
  productName: { en: `Accessory ${n}` },
  name: { en: 'Grey' },
  price: '12.00',
  available: true,
  ...overrides,
})

describe('VariantEditorPage', () => {
  it('creates a variant with price, image and variant attributes, then continues on its page', async () => {
    let posted: VariantInput | undefined
    const created: Variant = { ...ivory, id: ids.id(399), name: { en: 'Standard' }, addons: [] }
    let product = dimmer
    const { uploads } = handlers(() => product)
    server.use(
      http.post('/api/products/:id/variants', async ({ request }) => {
        posted = (await request.json()) as VariantInput
        product = { ...dimmer, variants: [...dimmer.variants, created] }
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: newRoute })

    expect(await screen.findByRole('heading', { name: 'New variant' })).toBeInTheDocument()
    expect(screen.getByText('Variant of M485/DIM.4 · Dimmer 4ch')).toBeInTheDocument()
    expect(region('Add-ons')).toHaveTextContent('Add-ons can be added once the variant is created.')
    await u.type((await translation(u, document.body, 'Name', 'en')), 'Standard')
    await u.type(screen.getByLabelText('Price'), '27.5.0')
    await u.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Enter a price such as 27 or 27.50 (up to 10 digits and 2 decimals).')).toBeInTheDocument()
    expect(screen.getByLabelText('Price')).toHaveFocus()
    await u.clear(screen.getByLabelText('Price'))
    await u.type(screen.getByLabelText('Price'), '27.5')

    await u.upload(screen.getByLabelText('Image'), new File(['png'], 'photo.png', { type: 'image/png' }))
    expect(await screen.findByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${uploadedId}`)
    expect(uploads).toEqual([{ name: 'photo.png', type: 'image/png' }])

    // Only the variant attributes of the category.
    const attributes = region('Attributes')
    expect(within(attributes).queryByLabelText('Width')).not.toBeInTheDocument()
    await chooseOption(u, within(attributes).getByLabelText('Colour'), 'Black')
    await u.click(within(attributes).getByLabelText('Gloss'))
    await u.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Variant created. You can now add its add-ons.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit variant' })).toBeInTheDocument()
    expect(posted).toEqual({
      name: { en: 'Standard' },
      price: '27.5',
      imageFileId: uploadedId,
      attributes: { colour: 'black', gloss: true },
      isActive: true,
    })
  })

  it('updates a variant and clears its image by leaving it out', async () => {
    const u = userEvent.setup()
    const { puts } = handlers()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    expect(await screen.findByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${ivory.imageFileId}`)
    expect(screen.getByLabelText('Price')).toHaveValue('27.00')
    expect(screen.getByLabelText('SKU')).toHaveValue('M485-IW')
    await u.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(screen.queryByRole('img', { name: 'Image' })).not.toBeInTheDocument()
    await u.clear(screen.getByLabelText('SKU'))
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts).toEqual([
      {
        name: ivory.name,
        price: '27.00',
        attributes: { colour: 'white' },
        isActive: true,
        expectedUpdatedAt: ivory.updatedAt,
      },
    ])
  })

  it('takes a price with a decimal comma and refuses other number forms', async () => {
    const u = userEvent.setup()
    const { puts } = handlers()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const priceField = await screen.findByLabelText('Price')
    await u.clear(priceField)
    await u.type(priceField, '0x1A')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Enter a price such as 27 or 27.50 (up to 10 digits and 2 decimals).')).toBeInTheDocument()
    expect(puts).toEqual([])

    await u.clear(priceField)
    await u.type(priceField, '27,5')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].price).toBe('27.5')
  })

  it('reads "Back to product" while nothing is unsaved and "Cancel" while it is', async () => {
    const u = userEvent.setup()
    handlers()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    expect(await screen.findByRole('link', { name: 'Back to product' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}`)
    await u.type(screen.getByLabelText('SKU'), 'X')
    expect(screen.queryByRole('link', { name: 'Back to product' })).not.toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    await u.click(within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Leave page' }))
    expect(await screen.findByText('product page')).toBeInTheDocument()
  })

  it('shows a taken name or SKU at its field', async () => {
    let respond = () => problem(409, { code: 'variant.name_taken', params: { name: 'Ivory White' } })
    const u = userEvent.setup()
    handlers(undefined, () => respond())
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    await u.click(await screen.findByRole('button', { name: 'Update' }))
    // The English tab is shown (the UI language).
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(expect.stringContaining('"Ivory White"') as unknown as string),
    )
    expect(screen.getByLabelText('Name')).toHaveFocus()

    respond = () => problem(409, { code: 'variant.sku_taken', params: { sku: 'M485-IW' } })
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.getByLabelText('SKU')).toHaveAccessibleDescription(expect.stringContaining('"M485-IW"') as unknown as string))
  })

  it('shows a server error of the German name on the German tab', async () => {
    const u = userEvent.setup()
    handlers(undefined, () =>
      problem(422, { code: 'validation.failed', fields: [{ location: 'body.name.de', code: 'validation.too_long', params: { max: 100 } }] }),
    )
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    await u.click(await screen.findByRole('button', { name: 'Update' }))

    const basics = region('Basics')
    await waitFor(() => expect(shownTranslation(basics, 'Name').language).toBe('German'))
    expect(shownTranslation(basics, 'Name').input).toHaveAccessibleDescription('This value is too long (at most 100 characters).')
    expect(shownTranslation(basics, 'Name').input).toHaveFocus()
  })

  it('keeps Update disabled while an image uploads', async () => {
    handlers()
    let finish: () => void = () => {}
    server.use(
      http.post('/api/files', async () => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return HttpResponse.json(
          { id: uploadedId, url: `/api/files/${uploadedId}`, contentType: 'image/png', size: 3, sha256: 'ab', createdAt: '2026-01-01T00:00:00Z' },
          { status: 201 },
        )
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    await u.upload(await screen.findByLabelText('Image'), new File(['png'], 'photo.png', { type: 'image/png' }))
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()

    finish()
    await waitFor(() => expect(screen.getByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${uploadedId}`))
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled()
  })

  it('replaces the image, and keeps the previous one when an upload fails', async () => {
    const u = userEvent.setup()
    const { puts } = handlers()
    // The first upload fails, the next ones succeed.
    server.use(http.post('/api/files', () => problem(422, { code: 'file.too_many_pixels', params: { megapixels: 25 } }), { once: true }))
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    expect(await screen.findByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${ivory.imageFileId}`)
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
    await u.upload(screen.getByLabelText('Image'), new File(['jpg'], 'huge.jpg', { type: 'image/jpeg' }))

    expect(await screen.findByText('The image is too large (at most 25 megapixels).')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${ivory.imageFileId}`)
    // The visible button carries the error, not the hidden file input.
    expect(screen.getByRole('button', { name: 'Replace' })).toHaveAttribute('aria-invalid', 'true')

    await u.upload(screen.getByLabelText('Image'), new File(['png'], 'photo.png', { type: 'image/png' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${uploadedId}`))
    expect(screen.queryByText(/too large/)).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].imageFileId).toBe(uploadedId)
  })

  it('shows an image that no longer exists at the image', async () => {
    const u = userEvent.setup()
    handlers(undefined, () =>
      problem(422, { code: 'validation.failed', fields: [{ location: 'body.imageFileId', code: 'file.not_found' }] }),
    )
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    await u.click(await screen.findByRole('button', { name: 'Update' }))

    expect(await screen.findByText('This file no longer exists.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Replace' })).toHaveFocus()
  })

  it('keeps unsaved add-ons after an update of the variant and still asks before leaving', async () => {
    const { puts } = handlers()
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    await u.click(within(addons).getByRole('button', { name: 'Remove FR-1 White' }))
    expect(addons).toHaveTextContent('The add-ons have unsaved changes.')
    await u.clear(screen.getByLabelText('SKU'))
    await u.type(screen.getByLabelText('SKU'), 'NEW')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts).toHaveLength(1)
    // The update saved the variant only: the add-on list stays as edited and says so.
    expect(screen.getAllByText('The add-ons have unsaved changes.')).toHaveLength(2)
    expect(within(addons).queryByRole('group', { name: 'FR-1 White' })).not.toBeInTheDocument()
    expect(within(addons).getByRole('button', { name: /Save add-ons/ })).toBeEnabled()

    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('refuses other file types before uploading and shows the server reasons', async () => {
    const u = userEvent.setup({ applyAccept: false })
    const { uploads } = handlers()
    renderRoutes(routes, { me: adminMe, route: newRoute })

    await u.upload(await screen.findByLabelText('Image'), new File(['gif'], 'anim.gif', { type: 'image/gif' }))
    expect(await screen.findByText('Only JPEG, PNG and WebP images are accepted.')).toBeInTheDocument()
    expect(uploads).toEqual([])

    server.use(http.post('/api/files', () => problem(422, { code: 'file.too_many_pixels', params: { megapixels: 40 } })))
    await u.upload(screen.getByLabelText('Image'), new File(['jpg'], 'huge.jpg', { type: 'image/jpeg' }))
    expect(await screen.findByText('The image is too large (at most 40 megapixels).')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Image' })).not.toBeInTheDocument()
  })

  it('finds add-ons, marks them required, orders and saves the whole list', async () => {
    let saved: AddonList | undefined
    const searched: Record<string, string>[] = []
    handlers()
    const other = searchItem(501, { sku: 'ACC-501-GR' })
    server.use(
      http.get('/api/variants', ({ request }) => {
        searched.push(Object.fromEntries(new URL(request.url).searchParams))
        const self = searchItem(0, { id: ivory.id, modelNumber: dimmer.modelNumber })
        const linked = searchItem(0, { id: ivory.addons[0].addonVariantId, modelNumber: 'FR-1' })
        const sibling = searchItem(0, { id: black.id, modelNumber: dimmer.modelNumber, name: { en: 'Black' }, available: false })
        return HttpResponse.json({ items: [self, linked, sibling, other], total: 4 })
      }),
      http.put('/api/products/:id/variants/:variantId/addons', async ({ request }) => {
        saved = (await request.json()) as AddonList
        return HttpResponse.json({
          ...ivory,
          addons: saved.addons.map((a, i) => ({
            ...(a.addonVariantId === other.id
              ? { ...ivory.addons[0], addonVariantId: other.id, modelNumber: 'ACC-501', variantName: { en: 'Grey' } }
              : ivory.addons[0]),
            required: a.required ?? false,
            sortOrder: i + 1,
          })),
        })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    const linked = within(addons).getByRole('list', { name: 'Linked add-ons' })
    expect(within(linked).getByRole('group', { name: 'FR-1 White' })).toHaveTextContent('$5.00')
    expect(within(linked).getByRole('checkbox', { name: 'FR-1 White is required' })).toBeChecked()
    // The linked add-on's product opens from its row.
    expect(within(linked).getByRole('link', { name: 'Frame 1' })).toHaveAttribute('href', `/catalog/products/${ivory.addons[0].productId}`)
    expect(within(addons).getByRole('button', { name: /Save add-ons/ })).toBeDisabled()

    await u.type(within(addons).getByLabelText('Find a variant to add'), 'grey')
    await waitFor(() => expect(searched[searched.length - 1]).toEqual({ search: 'grey', limit: '20', offset: '0' }))
    const results = within(addons).getByRole('region', { name: 'Search results' })
    // Neither the variant itself nor what is linked already.
    await waitFor(() =>
      expect(within(results).getAllByRole('button', { name: /^Add / }).map((b) => b.getAttribute('aria-label'))).toEqual([
        'Add M485/DIM.4 Black',
        'Add ACC-501 Grey',
      ]),
    )
    expect(results).toHaveTextContent('Unavailable')
    expect(results).toHaveTextContent('SKU ACC-501-GR')
    expect(results).toHaveTextContent('2 variants shown')

    await u.click(within(results).getByRole('button', { name: 'Add ACC-501 Grey' }))
    expect(within(results).queryByRole('button', { name: 'Add ACC-501 Grey' })).not.toBeInTheDocument()
    expect(results).toHaveTextContent('1 variant shown')
    expect(addons).toHaveTextContent('The add-ons have unsaved changes.')
    const added = within(linked).getByRole('group', { name: 'ACC-501 Grey' })
    expect(within(added).getByRole('checkbox', { name: 'ACC-501 Grey is required' })).not.toBeChecked()
    await u.click(within(added).getByRole('checkbox', { name: 'ACC-501 Grey is required' }))
    await u.click(within(added).getByRole('button', { name: 'Move ACC-501 Grey up' }))
    const names = () => within(linked).getAllByRole('group').map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)
    expect(names()).toEqual(['ACC-501 Grey', 'FR-1 White'])

    await u.click(within(addons).getByRole('button', { name: /Save add-ons/ }))

    expect(await within(addons).findByText('Add-ons saved.')).toBeInTheDocument()
    expect(addons).not.toHaveTextContent('unsaved changes')
    expect(saved).toEqual({
      addons: [
        { addonVariantId: other.id, required: true },
        { addonVariantId: ivory.addons[0].addonVariantId, required: true },
      ],
    })
    expect(within(addons).getByRole('button', { name: /Save add-ons/ })).toBeDisabled()

    // Removing is saved the same way.
    await u.click(within(linked).getByRole('button', { name: 'Remove FR-1 White' }))
    await u.click(within(addons).getByRole('button', { name: /Save add-ons/ }))
    await waitFor(() => expect(saved).toEqual({ addons: [{ addonVariantId: other.id, required: true }] }))
  })

  it('browses variants in catalog order before anything is typed, pages with Show more and filters by type and category', async () => {
    const searched: Record<string, string>[] = []
    handlers()
    // 45 variants of the catalog: the first page holds the variant itself and its linked add-on.
    const catalog = [
      searchItem(0, { id: ivory.id, modelNumber: dimmer.modelNumber, name: { en: 'Ivory White' } }),
      searchItem(0, { id: ivory.addons[0].addonVariantId, modelNumber: 'FR-1' }),
      ...Array.from({ length: 43 }, (_, i) => searchItem(600 + i)),
    ]
    server.use(
      http.get('/api/variants', ({ request }) => {
        const params = new URL(request.url).searchParams
        searched.push(Object.fromEntries(params))
        const rows =
          params.get('productTypeId') === knxType.id
            ? catalog.slice(2, 5)
            : params.get('categoryId') === gatewayCategory.id
              ? catalog.slice(2, 4)
              : catalog
        const offset = Number(params.get('offset'))
        return HttpResponse.json({ items: rows.slice(offset, offset + Number(params.get('limit'))), total: rows.length })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    const results = within(addons).getByRole('region', { name: 'Search results' })
    // The count is what is shown: 20 loaded, the variant itself and the linked one hidden.
    expect(await within(results).findByText('18 variants shown')).toBeInTheDocument()
    expect(searched).toEqual([{ limit: '20', offset: '0' }])
    expect(within(results).getAllByRole('button', { name: /^Add / })[0]).toHaveAccessibleName('Add ACC-600 Grey')

    await u.click(within(results).getByRole('button', { name: 'Show more' }))
    expect(await within(results).findByText('38 variants shown')).toBeInTheDocument()
    await u.click(within(results).getByRole('button', { name: 'Show more' }))
    expect(await within(results).findByText('43 variants shown')).toBeInTheDocument()
    // The server has no more.
    expect(within(results).queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    expect(searched.map((p) => p.offset)).toEqual(['0', '20', '40'])

    // Each row names its product with the type badge and the category.
    const first = within(results).getAllByRole('listitem')[0]
    expect(first).toHaveTextContent('ZBAccessory 600 · Dimmer actuators')
    expect(within(first).getByTestId('type-abbreviation')).toHaveStyle({ backgroundColor: '#1f6feb' })

    // The type filter offers the type names and starts again at the first page.
    const typeFilter = within(addons).getByLabelText('Product type')
    expect(await optionTexts(u, typeFilter)).toEqual(['All product types', 'ZBZigbee', 'KNX', 'Legacy (inactive)'])
    await chooseOption(u, typeFilter, 'KNX')
    expect(await within(results).findByText('3 variants shown')).toBeInTheDocument()
    expect(searched[searched.length - 1]).toEqual({ productTypeId: knxType.id, limit: '20', offset: '0' })
    expect(within(results).queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()

    // So does the category filter.
    await chooseOption(u, typeFilter, 'All product types')
    const categoryFilter = within(addons).getByLabelText('Category')
    expect(await optionTexts(u, categoryFilter)).toEqual(['All categories', 'Dimmer actuators', 'Gateways', 'Retired (inactive)'])
    await chooseOption(u, categoryFilter, 'Gateways')
    expect(await within(results).findByText('2 variants shown')).toBeInTheDocument()
    expect(searched[searched.length - 1]).toEqual({ categoryId: gatewayCategory.id, limit: '20', offset: '0' })
  })

  it('says when nothing matches, also when only the variant itself and linked add-ons match', async () => {
    handlers()
    server.use(
      http.get('/api/variants', () =>
        HttpResponse.json({ items: [searchItem(0, { id: ivory.id }), searchItem(0, { id: ivory.addons[0].addonVariantId })], total: 2 }),
      ),
    )
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    expect(await within(addons).findByText('No matching variants.')).toBeInTheDocument()
    expect(addons).not.toHaveTextContent('shown')
  })

  it('shows add-on errors at the row they belong to', async () => {
    handlers()
    const gone = searchItem(502)
    server.use(
      http.get('/api/variants', () => HttpResponse.json({ items: [gone], total: 1 })),
      http.put('/api/products/:id/variants/:variantId/addons', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'body.addons[1].addonVariantId', code: 'addon.variant_not_found' }] }),
      ),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    await u.type(within(addons).getByLabelText('Find a variant to add'), 'acc')
    await u.click(await within(addons).findByRole('button', { name: 'Add ACC-502 Grey' }))
    await u.click(within(addons).getByRole('button', { name: /Save add-ons/ }))

    expect(await within(addons).findByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
    expect(within(addons).getByRole('group', { name: 'ACC-502 Grey' })).toHaveTextContent('This variant no longer exists.')
    expect(within(addons).getByRole('group', { name: 'FR-1 White' })).not.toHaveTextContent('no longer exists')
  })

  it('asks before leaving with unsaved add-ons', async () => {
    handlers()
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    const addons = await screen.findByRole('region', { name: 'Add-ons' })
    await u.click(within(addons).getByRole('button', { name: 'Remove FR-1 White' }))
    await u.click(screen.getByRole('link', { name: 'Cancel' }))

    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Leave page' }))
    expect(await screen.findByText('product page')).toBeInTheDocument()
  })

  it('reloads after someone else changed the variant', async () => {
    let product = dimmer
    const { puts } = handlers(
      () => product,
      () => (puts.length === 1 ? problem(409, { code: 'variant.stale' }) : HttpResponse.json(product.variants[0])),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: ivoryRoute })

    await u.clear(await screen.findByLabelText('Price'))
    await u.type(screen.getByLabelText('Price'), '30')
    product = { ...dimmer, variants: [{ ...ivory, price: '29.00', updatedAt: '2026-02-01T00:00:00Z' }, black] }
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed this variant in the meantime.')
    await u.click(within(alert).getByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(screen.getByLabelText('Price')).toHaveValue('29.00'))
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((p) => [p.price, p.expectedUpdatedAt])).toEqual([
      ['30', ivory.updatedAt],
      ['29.00', '2026-02-01T00:00:00Z'],
    ])
  })

  it('shows the variant read-only without catalog.write', async () => {
    const locked = { update: false, delete: false }
    handlers(() => ({ ...dimmer, can: locked, variants: [{ ...ivory, can: locked }] }))
    renderRoutes(routes, { me: userMe, route: ivoryRoute })

    expect(await screen.findByRole('heading', { name: 'Ivory White' })).toBeInTheDocument()
    expect(screen.getByLabelText('Price')).toBeDisabled()
    expect(screen.getByRole('img', { name: 'Image' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'FR-1 White is required' })).toBeDisabled()
    expect(screen.queryByLabelText('Find a variant to add')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update|save|remove|move|choose/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to product' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}`)
  })

  it('shows when the variant does not exist', async () => {
    handlers()
    renderRoutes(routes, { me: adminMe, route: `/catalog/products/${dimmer.id}/variants/${ids.id(999)}` })

    expect(await screen.findByRole('heading', { name: 'Variant not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to product' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}`)
  })
})
