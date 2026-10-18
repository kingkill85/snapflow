import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Product, ProductInput, ProductUpdate } from '@/api/generated/model'
import { routes as appRoutes } from '@/app/routes'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { ProductEditorPage } from './ProductEditorPage'
import { black, dimmer, dimmerType, gatewayType, ids, ivory, problem, types } from './test-fixtures'

const routes = [
  { path: '/catalog/products', element: <p>list page</p> },
  { path: '/catalog/products/new', element: <ProductEditorPage /> },
  { path: '/catalog/products/:id', element: <ProductEditorPage /> },
  { path: '/catalog/products/:id/variants/new', element: <p>new variant page</p> },
  { path: '/catalog/products/:id/variants/:variantId', element: <p>variant page</p> },
]
const editRoute = `/catalog/products/${dimmer.id}`

const region = (name: string) => screen.getByRole('region', { name })
const attributes = () => region('Attributes')
const inAttributes = (label: string) => within(attributes()).getByLabelText(label)

type User = ReturnType<typeof userEvent.setup>

/** GET returns `item()`, PUT records the body and answers with `respond` (default: the item). */
function editHandlers(item: () => Product = () => dimmer, respond?: () => Response) {
  const puts: ProductUpdate[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: types })),
    http.get('/api/products/:id', () => HttpResponse.json(item())),
    http.put('/api/products/:id', async ({ request }) => {
      puts.push((await request.json()) as ProductUpdate)
      return respond ? respond() : HttpResponse.json(item())
    }),
  )
  return { puts }
}

async function openEditor(item?: () => Product, respond?: () => Response) {
  const calls = editHandlers(item, respond)
  renderRoutes(routes, { me: adminMe, route: editRoute })
  await screen.findByRole('heading', { name: 'Edit product' })
  return calls
}

const add = async (u: User, label: string, ...items: string[]) => {
  for (const item of items) await u.type(inAttributes(label), `${item}{Enter}`)
}

describe('ProductEditorPage', () => {
  it('creates a product with a value of every attribute type, sending exactly what is set', async () => {
    let posted: ProductInput | undefined
    const created = { ...dimmer, id: ids.id(299), variants: [] }
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items: types })),
      http.post('/api/products', async ({ request }) => {
        posted = (await request.json()) as ProductInput
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get('/api/products/:id', () => HttpResponse.json(created)),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/products/new' })

    expect(await screen.findByRole('heading', { name: 'New product' })).toBeInTheDocument()
    expect(attributes()).toHaveTextContent('Choose a product type to fill in its attributes.')
    // Only active types are offered for a new product.
    expect(within(screen.getByLabelText('Product type')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a product type',
      'Dimmer actuator',
      'Gateway',
    ])
    await u.selectOptions(screen.getByLabelText('Product type'), dimmerType.id)
    await u.type(screen.getByLabelText('Model number'), ' M1 ')
    await u.type(screen.getByLabelText('Name (English)'), 'Dimmer')

    await u.type(inAttributes('Series'), 'Pro')
    await u.type(inAttributes('Power'), '12.5')
    await u.type(inAttributes('Width'), '4')
    await u.click(inAttributes('DALI'))
    await u.selectOptions(inAttributes('Bus system'), 'knx')
    const loads = within(attributes()).getByRole('group', { name: 'Loads' })
    await u.click(within(loads).getByLabelText('Motor'))
    await u.click(within(loads).getByLabelText('LED'))
    await add(u, 'Protocols', 'DALI', 'KNX')
    await add(u, 'Channel currents', '1.5')
    await u.type(inAttributes('Channel currents'), '2')
    await u.click(within(attributes()).getAllByRole('button', { name: 'Add' })[1])
    // Variant attributes are not set on the product.
    expect(within(attributes()).queryByLabelText('Colour')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Create' }))

    // The new product's page, to add its variants.
    expect(await screen.findByText('Product created. Add its variants below.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument()
    expect(posted).toEqual({
      productTypeId: dimmerType.id,
      modelNumber: 'M1',
      name: { en: 'Dimmer' },
      attributes: {
        series: 'Pro',
        power: 12.5,
        width_te: 4,
        dali: true,
        bus_system: 'knx',
        loads: ['led', 'motor'],
        protocols: ['DALI', 'KNX'],
        currents: [1.5, 2],
      },
      isActive: true,
    })
  })

  it('renders one input per attribute type with its unit, bounds and required mark', async () => {
    await openEditor()

    expect(inAttributes('Series')).toHaveValue('Pro')
    expect(inAttributes('Series')).toHaveAccessibleDescription('At most 20 characters')
    const power = inAttributes('Power')
    expect(power).toHaveValue('300')
    expect(power).toHaveAttribute('inputmode', 'decimal')
    expect(power).toHaveAccessibleDescription('0 to 500')
    expect(power.parentElement).toHaveTextContent('W')
    const width = inAttributes('Width')
    expect(width).toHaveAttribute('inputmode', 'numeric')
    expect(width).toHaveAttribute('aria-required', 'true')
    expect(width).toHaveAccessibleDescription('Required · 1 to 12 · Whole number')
    expect(inAttributes('DALI')).toBeChecked()
    const bus = inAttributes('Bus system')
    expect(bus).toHaveValue('zigbee')
    expect(within(bus).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not set', 'Zigbee', 'KNX'])
    const loads = within(attributes()).getByRole('group', { name: 'Loads' })
    expect(within(loads).getByLabelText('LED')).toBeChecked()
    expect(within(loads).getByLabelText('Halogen')).not.toBeChecked()
    expect(within(loads).getByLabelText('Motor')).toBeChecked()
    expect(inAttributes('Protocols')).toHaveAccessibleDescription('At most 4 items')
    expect(within(attributes()).getByRole('button', { name: 'Remove DALI' })).toBeInTheDocument()
    expect(attributes()).toHaveTextContent('1.5 A')
    expect(attributes()).toHaveTextContent('2 A')
  })

  it('saves unchanged values as stored, with the version it was loaded from', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts).toEqual([
      {
        productTypeId: dimmerType.id,
        modelNumber: dimmer.modelNumber,
        name: dimmer.name,
        description: dimmer.description,
        attributes: dimmer.attributes,
        isActive: true,
        expectedUpdatedAt: dimmer.updatedAt,
      },
    ])
  })

  it('edits lists and clears values, leaving out what is not set', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Series'))
    await u.clear(inAttributes('Power'))
    await u.click(inAttributes('DALI'))
    await u.selectOptions(inAttributes('Bus system'), '')
    await u.click(within(attributes()).getByLabelText('LED'))
    await u.click(within(attributes()).getByLabelText('Motor'))
    await u.click(within(attributes()).getByRole('button', { name: 'Remove DALI' }))
    await u.click(within(attributes()).getByRole('button', { name: 'Remove 1.5' }))
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    // An unchecked yes/no is "no", not "not set".
    expect(puts[0].attributes).toEqual({ width_te: 4, dali: false, currents: [2] })
  })

  it('checks that numbers are numbers before saving', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Width'))
    await u.type(inAttributes('Width'), '2.5')
    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), 'much')
    await add(u, 'Channel currents', 'x')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await within(attributes()).findByText('This value must be a whole number.')).toBeInTheDocument()
    expect(inAttributes('Power')).toHaveAccessibleDescription('Enter a number.')
    expect(inAttributes('Channel currents')).toHaveAccessibleDescription('Enter a number.')
    expect(inAttributes('Power')).toHaveFocus()
    expect(puts).toEqual([])
  })

  it('shows server errors of attribute values at their inputs, list items at their list', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.attributes.width_te', code: 'attribute.range', params: { min: 1, max: 12 } },
          { location: 'body.attributes.protocols[1]', code: 'attribute.length_max', params: { max: 10 } },
        ],
      }),
    )

    await add(u, 'Protocols', 'A very long protocol')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
    expect(inAttributes('Width')).toHaveAccessibleDescription('Enter a value between 1 and 12.')
    expect(inAttributes('Width')).toHaveAttribute('aria-invalid', 'true')
    expect(inAttributes('Protocols')).toHaveAccessibleDescription('Number of characters: at most 10.')
    expect(inAttributes('Width')).toHaveFocus()
  })

  it('shows a taken model number at its field', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () => problem(409, { code: 'product.model_number_taken', params: { modelNumber: 'M485/DIM.4' } }))

    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() =>
      expect(screen.getByLabelText('Model number')).toHaveAccessibleDescription('The model number "M485/DIM.4" is already used.'),
    )
  })

  it('lists values no longer in the schema: kept unless removed, wrong-scope values with their error', async () => {
    const withStale: Product = {
      ...dimmer,
      attributes: { ...dimmer.attributes, power: 600, colour: 'white' },
      staleAttributes: { old_width: 4, legacy_flag: true },
      attributeErrors: [
        { location: 'attributes.colour', code: 'attribute.wrong_scope', params: { scope: 'variant' } },
        { location: 'attributes.power', code: 'attribute.range_max', params: { max: 500 } },
      ],
    }
    const u = userEvent.setup()
    const { puts } = await openEditor(() => withStale)

    // Problems of the stored values show from the start.
    expect(attributes()).toHaveTextContent('Some stored values do not match')
    expect(inAttributes('Power')).toHaveAccessibleDescription('Enter a value of at most 500.')
    const extra = within(attributes()).getByRole('group', { name: 'Values no longer in the schema' })
    const rows = within(extra).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('colourwhite'),
      expect.stringContaining('legacy_flagYes'),
      expect.stringContaining('old_width4'),
    ])
    expect(rows[0]).toHaveTextContent('This attribute is set per variant.')

    await u.click(within(extra).getByRole('button', { name: 'Remove colour' }))
    await u.click(within(extra).getByRole('button', { name: 'Remove legacy_flag' }))
    expect(rows[1]).toHaveTextContent('Removed on save')
    await u.click(within(extra).getByRole('button', { name: 'Keep legacy_flag' }))
    await u.click(within(extra).getByRole('button', { name: 'Remove old_width' }))
    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), '450')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    // Kept stale values go back unchanged; removed ones are left out.
    expect(puts[0].attributes).toEqual({ ...dimmer.attributes, power: 450, legacy_flag: true })
  })

  it('re-renders the attributes for a new product type and keeps the old values as no longer in the schema', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.selectOptions(screen.getByLabelText('Product type'), gatewayType.id)

    expect(screen.getByText(/You changed the product type/)).toBeInTheDocument()
    expect(within(attributes()).queryByLabelText('Power')).not.toBeInTheDocument()
    expect(inAttributes('Series')).toHaveValue('Pro')
    await u.type(inAttributes('Ports'), '8')
    const extra = within(attributes()).getByRole('group', { name: 'Values no longer in the schema' })
    expect(within(extra).getAllByRole('listitem').map((r) => r.querySelector('code')?.textContent)).toEqual([
      'bus_system',
      'currents',
      'dali',
      'loads',
      'power',
      'protocols',
      'width_te',
    ])
    await u.click(within(extra).getByRole('button', { name: 'Remove dali' }))

    // Back to the old type: its inputs again, with the values as edited.
    await u.selectOptions(screen.getByLabelText('Product type'), dimmerType.id)
    expect(inAttributes('Power')).toHaveValue('300')
    await u.selectOptions(screen.getByLabelText('Product type'), gatewayType.id)
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    const { dali: _removed, series: _series, ...stale } = dimmer.attributes as Record<string, unknown>
    expect(puts[0].productTypeId).toBe(gatewayType.id)
    expect(puts[0].attributes).toEqual({ series: 'Pro', ports: 8, ...stale })
  })

  it('reloads after someone else changed the product', async () => {
    let version = dimmer
    const { puts } = editHandlers(
      () => version,
      () => (puts.length === 1 ? problem(409, { code: 'product.stale' }) : HttpResponse.json(version)),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    await u.clear(await screen.findByLabelText('Name (English)'))
    await u.type(screen.getByLabelText('Name (English)'), 'My dimmer')
    version = { ...dimmer, name: { en: 'Their dimmer' }, updatedAt: '2026-02-01T00:00:00Z' }
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed this product in the meantime.')
    await u.click(within(alert).getByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(screen.getByLabelText('Name (English)')).toHaveValue('Their dimmer'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((p) => [p.name.en, p.expectedUpdatedAt])).toEqual([
      ['My dimmer', dimmer.updatedAt],
      ['Their dimmer', '2026-02-01T00:00:00Z'],
    ])
  })

  it('asks before leaving with unsaved changes, also for a variant', async () => {
    const u = userEvent.setup()
    await openEditor()

    await u.type(screen.getByLabelText('Name (German)'), ' neu')
    await u.click(within(region('Variants')).getByRole('link', { name: 'Ivory White' }))

    let dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Name (German)')).toHaveValue('Dimmer 4-fach neu')

    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Leave page' }))
    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('leaves without asking when nothing changed', async () => {
    const u = userEvent.setup()
    await openEditor()

    await u.click(screen.getByRole('link', { name: 'Cancel' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('lists the variants with image, price, status and add-ons, and reorders them at once', async () => {
    let product = dimmer
    let order: unknown
    editHandlers(() => product)
    server.use(
      http.put('/api/products/:id/variants/order', async ({ request }) => {
        order = await request.json()
        product = { ...dimmer, variants: [black, ivory] }
        return HttpResponse.json(product)
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    const variants = await screen.findByRole('region', { name: 'Variants' })
    const ivoryRow = within(variants).getByRole('link', { name: 'Ivory White' }).closest('tr')!
    expect(ivoryRow.querySelector('img')).toHaveAttribute('src', `/api/files/${ivory.imageFileId}`)
    expect(ivoryRow).toHaveTextContent('M485-IW')
    expect(ivoryRow).toHaveTextContent('$27.00')
    expect(ivoryRow).toHaveTextContent('Active')
    expect(ivoryRow.lastElementChild?.previousElementSibling).toHaveTextContent('1')
    const blackRow = within(variants).getByRole('link', { name: 'Black' }).closest('tr')!
    expect(blackRow).toHaveTextContent('Inactive')
    expect(within(variants).getByRole('link', { name: 'Add variant' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}/variants/new`)

    await u.click(within(variants).getByRole('button', { name: 'Move Black up' }))

    await waitFor(() => expect(within(variants).getAllByRole('link', { name: /Ivory White|Black/ }).map((l) => l.textContent)).toEqual(['Black', 'Ivory White']))
    expect(order).toEqual({ ids: [black.id, ivory.id] })
  })

  it('deletes a variant after confirming', async () => {
    let product = dimmer
    let deleted = ''
    editHandlers(() => product)
    server.use(
      http.delete('/api/products/:id/variants/:variantId', ({ params }) => {
        deleted = String(params.variantId)
        product = { ...dimmer, variants: [black] }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    const variants = await screen.findByRole('region', { name: 'Variants' })
    const ivoryRow = within(variants).getByRole('link', { name: 'Ivory White' }).closest('tr')!
    await u.click(within(ivoryRow).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete variant' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(variants).queryByRole('link', { name: 'Ivory White' })).not.toBeInTheDocument())
    expect(deleted).toBe(ivory.id)
  })

  it('shows the product read-only without catalog.write', async () => {
    const readOnly = (p: Product): Product => ({ ...p, can: { update: false, delete: false } })
    editHandlers(() => ({ ...readOnly(dimmer), variants: dimmer.variants.map((v) => ({ ...v, can: { update: false, delete: false } })) }))
    renderRoutes(routes, { me: userMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Dimmer 4ch' })).toBeInTheDocument()
    expect(screen.getByText('You can view this product but not change it.')).toBeInTheDocument()
    expect(screen.getByLabelText('Model number')).toBeDisabled()
    expect(inAttributes('Width')).toBeDisabled()
    expect(inAttributes('DALI')).toBeDisabled()
    expect(attributes()).toHaveTextContent('DALI')
    expect(screen.queryByRole('button', { name: /update|remove|move|delete|add/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /add variant|edit/i })).not.toBeInTheDocument()
    expect(within(region('Variants')).getByRole('link', { name: 'Ivory White' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/products')
  })

  it('does not offer creating to users without catalog.write', async () => {
    renderRoutes(appRoutes, { me: userMe, route: '/catalog/products/new' })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
  })

  it.each([
    ['does not exist', () => problem(404, { code: 'product.not_found' })],
    ['id is invalid', () => problem(422, { code: 'validation.failed', fields: [{ location: 'path.id', code: 'validation.invalid' }] })],
  ])('shows not found when the product %s', async (_, respond) => {
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items: types })),
      http.get('/api/products/:id', respond),
    )
    renderRoutes(routes, { me: adminMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Product not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/products')
  })
})
