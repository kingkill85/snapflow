import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AddonList, Product, Variant, VariantInput, VariantSearchItem, VariantUpdate } from '@/api/generated/model'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { black, dimmer, ids, ivory, problem, types } from './test-fixtures'
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

/** GET product returns `product()`, PUT variant records and answers with `respond` (default: the variant). */
function handlers(product: () => Product = () => dimmer, respond?: () => Response) {
  const puts: VariantUpdate[] = []
  const uploads: { name: string; type: string }[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: types })),
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
    await u.type(screen.getByLabelText('Name (English)'), 'Standard')
    await u.type(screen.getByLabelText('Price'), '27.5.0')
    await u.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Enter a price such as 27 or 27.50 (up to 10 digits and 2 decimals).')).toBeInTheDocument()
    expect(screen.getByLabelText('Price')).toHaveFocus()
    await u.clear(screen.getByLabelText('Price'))
    await u.type(screen.getByLabelText('Price'), '27.5')

    await u.upload(screen.getByLabelText('Image'), new File(['png'], 'photo.png', { type: 'image/png' }))
    expect(await screen.findByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${uploadedId}`)
    expect(uploads).toEqual([{ name: 'photo.png', type: 'image/png' }])

    // Only the variant attributes of the type.
    const attributes = region('Attributes')
    expect(within(attributes).queryByLabelText('Width')).not.toBeInTheDocument()
    await u.selectOptions(within(attributes).getByLabelText('Colour'), 'black')
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
    let searched: URLSearchParams | undefined
    handlers()
    const other = searchItem(501)
    server.use(
      http.get('/api/variants', ({ request }) => {
        searched = new URL(request.url).searchParams
        const self = searchItem(0, { id: ivory.id, modelNumber: dimmer.modelNumber })
        const linked = searchItem(0, { id: ivory.addons[0].addonVariantId, modelNumber: 'FR-1' })
        const sibling = searchItem(0, { id: black.id, modelNumber: dimmer.modelNumber, name: { en: 'Black' }, available: false })
        return HttpResponse.json({ items: [self, linked, sibling, other], total: 30 })
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
    expect(within(addons).getByRole('button', { name: /Save add-ons/ })).toBeDisabled()

    await u.type(within(addons).getByLabelText('Find a variant to add'), 'grey')
    const results = await within(addons).findByRole('region', { name: 'Search results' })
    expect(Object.fromEntries(searched!)).toEqual({ search: 'grey', limit: '20' })
    // Neither the variant itself nor what is linked already.
    const offered = within(results).getAllByRole('button', { name: /^Add / }).map((b) => b.getAttribute('aria-label'))
    expect(offered).toEqual(['Add M485/DIM.4 Black', 'Add ACC-501 Grey'])
    expect(results).toHaveTextContent('Unavailable')
    expect(results).toHaveTextContent('4 of 30 shown; refine the search to find more.')

    await u.click(within(results).getByRole('button', { name: 'Add ACC-501 Grey' }))
    expect(within(results).queryByRole('button', { name: 'Add ACC-501 Grey' })).not.toBeInTheDocument()
    const added = within(linked).getByRole('group', { name: 'ACC-501 Grey' })
    expect(within(added).getByRole('checkbox', { name: 'ACC-501 Grey is required' })).not.toBeChecked()
    await u.click(within(added).getByRole('checkbox', { name: 'ACC-501 Grey is required' }))
    await u.click(within(added).getByRole('button', { name: 'Move ACC-501 Grey up' }))
    const names = () => within(linked).getAllByRole('group').map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)
    expect(names()).toEqual(['ACC-501 Grey', 'FR-1 White'])

    await u.click(within(addons).getByRole('button', { name: /Save add-ons/ }))

    expect(await within(addons).findByText('Add-ons saved.')).toBeInTheDocument()
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
