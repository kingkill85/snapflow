import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { ProductType } from '@/api/generated/model'
import { routes as appRoutes } from '@/app/routes'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { ProductTypeEditorPage } from './ProductTypeEditorPage'

const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const routes = [
  { path: '/catalog/product-types', element: <p>list page</p> },
  { path: '/catalog/product-types/new', element: <ProductTypeEditorPage /> },
  { path: '/catalog/product-types/:id', element: <ProductTypeEditorPage /> },
]

const existing: ProductType = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'dimmer_actuator',
  name: { en: 'Dimmer actuator', de: 'Dimmaktor' },
  description: { en: 'DIN rail dimmer' },
  sortOrder: 1,
  isActive: true,
  attributes: [
    { key: 'width_te', label: { en: 'Width', de: 'Breite' }, type: 'integer', required: true, unit: 'TE', min: 1, max: 12, scope: 'product' },
    {
      key: 'colour',
      label: { en: 'Colour' },
      type: 'enum',
      scope: 'variant',
      options: [
        { key: 'white', label: { en: 'White', de: 'Weiß' } },
        { key: 'black', label: { en: 'Black' } },
      ],
    },
    { key: 'protocols', label: { en: 'Protocols' }, type: 'list', itemType: 'text', max: 4, scope: 'product' },
  ],
  instanceAttributes: [{ key: 'bus_address', label: { en: 'Bus address' }, type: 'text', required: true }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
}

const group = (name: string, container: HTMLElement = document.body) => within(container).getByRole('group', { name })
/** The attribute row's own field (option rows inside repeat the labels). */
const own = (row: HTMLElement, label: string) => within(row).getAllByLabelText(label)[0]

describe('ProductTypeEditorPage', () => {
  it('creates a product type with an enum attribute, sending exactly what applies', async () => {
    let posted: unknown
    server.use(
      http.post('/api/product-types', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ ...existing, id: 'new' }, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/product-types/new' })

    expect(await screen.findByRole('heading', { name: 'New product type' })).toBeInTheDocument()
    await u.type(screen.getByLabelText('Key'), 'gateway')
    await u.type(screen.getByLabelText('Name (English)'), 'Gateway')
    await u.type(screen.getByLabelText('Name (German)'), 'Gateway')

    const attributes = screen.getByRole('region', { name: 'Attributes' })
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const row = group('Attribute 1', attributes)
    await u.type(own(row, 'Key'), 'bus_system')
    await u.type(own(row, 'Label (English)'), 'Bus system')
    // Bounds of a text attribute are lengths; an enum has none.
    expect(within(row).getByLabelText('Maximum length')).toBeInTheDocument()
    await u.type(within(row).getByLabelText('Maximum length'), '20')
    await u.selectOptions(within(row).getByLabelText('Type'), 'enum')
    expect(within(row).queryByLabelText('Maximum length')).not.toBeInTheDocument()
    await u.selectOptions(within(row).getByLabelText('Set per'), 'variant')
    await u.click(within(row).getByLabelText('Required'))
    await u.type(within(row).getByLabelText('Unit'), ' ')

    await u.click(within(row).getByRole('button', { name: 'Add option' }))
    await u.click(within(row).getByRole('button', { name: 'Add option' }))
    await u.type(within(group('Option 1', row)).getByLabelText('Key'), 'zigbee')
    await u.type(within(group('Option 1', row)).getByLabelText('Label (English)'), 'Zigbee')
    await u.type(within(group('Option 2', row)).getByLabelText('Key'), 'knx')
    await u.type(within(group('Option 2', row)).getByLabelText('Label (English)'), 'KNX')
    await u.type(within(group('Option 2', row)).getByLabelText('Label (German)'), 'KNX')
    // Move KNX first.
    await u.click(within(group('Option 2', row)).getByRole('button', { name: 'Move up' }))

    await u.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
    expect(posted).toEqual({
      key: 'gateway',
      name: { en: 'Gateway', de: 'Gateway' },
      isActive: true,
      attributes: [
        {
          key: 'bus_system',
          label: { en: 'Bus system' },
          type: 'enum',
          required: true,
          scope: 'variant',
          options: [
            { key: 'knx', label: { en: 'KNX', de: 'KNX' } },
            { key: 'zigbee', label: { en: 'Zigbee' } },
          ],
        },
      ],
      instanceAttributes: [],
    })
  })

  it('loads an existing schema and saves it unchanged', async () => {
    let put: unknown
    server.use(
      http.get('/api/product-types/:id', () => HttpResponse.json(existing)),
      http.put('/api/product-types/:id', async ({ request }) => {
        put = await request.json()
        return HttpResponse.json(existing)
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: `/catalog/product-types/${existing.id}` })

    expect(await screen.findByRole('heading', { name: 'Edit product type' })).toBeInTheDocument()
    const basics = screen.getByRole('region', { name: 'Basics' })
    expect(within(basics).getByLabelText('Key')).toHaveValue('dimmer_actuator')
    expect(within(basics).getByLabelText('Name (German)')).toHaveValue('Dimmaktor')
    expect(within(basics).getByLabelText('Description (English)')).toHaveValue('DIN rail dimmer')

    const attributes = screen.getByRole('region', { name: 'Attributes' })
    const width = group('Attribute 1', attributes)
    expect(own(width, 'Key')).toHaveValue('width_te')
    expect(within(width).getByLabelText('Type')).toHaveValue('integer')
    expect(within(width).getByLabelText('Minimum')).toHaveValue(1)
    expect(within(width).getByLabelText('Maximum')).toHaveValue(12)
    expect(within(width).getByLabelText('Unit')).toHaveValue('TE')
    expect(within(width).getByLabelText('Required')).toBeChecked()
    const colour = group('Attribute 2', attributes)
    expect(within(colour).getByLabelText('Set per')).toHaveValue('variant')
    expect(within(group('Option 1', colour)).getByLabelText('Label (German)')).toHaveValue('Weiß')
    const protocols = group('Attribute 3', attributes)
    expect(within(protocols).getByLabelText('Item type')).toHaveValue('text')
    expect(within(protocols).getByLabelText('Maximum items')).toHaveValue(4)

    const instance = screen.getByRole('region', { name: 'Instance attributes' })
    const busAddress = group('Attribute 1', instance)
    expect(own(busAddress, 'Key')).toHaveValue('bus_address')
    expect(within(busAddress).queryByLabelText('Set per')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
    expect(put).toEqual({
      key: existing.key,
      name: existing.name,
      description: existing.description,
      isActive: true,
      attributes: [
        { ...existing.attributes[0] },
        { ...existing.attributes[1], required: false },
        { ...existing.attributes[2], required: false },
      ],
      instanceAttributes: [{ key: 'bus_address', label: { en: 'Bus address' }, type: 'text', required: true }],
      expectedUpdatedAt: existing.updatedAt,
    })
  })

  it('shows server field errors at the attribute row and option they belong to', async () => {
    server.use(
      http.get('/api/product-types/:id', () => HttpResponse.json(existing)),
      http.put('/api/product-types/:id', () =>
        problem(422, {
          code: 'validation.failed',
          fields: [
            { location: 'body.attributes[1].options[1].key', code: 'attribute.option_key_duplicate' },
            { location: 'body.attributes[2].max', code: 'attribute.range_invalid' },
            { location: 'body.instanceAttributes[0].key', code: 'attribute.key_duplicate' },
          ],
        }),
      ),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: `/catalog/product-types/${existing.id}` })

    await u.click(await screen.findByRole('button', { name: 'Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
    const attributes = screen.getByRole('region', { name: 'Attributes' })
    const black = group('Option 2', group('Attribute 2', attributes))
    expect(within(black).getByLabelText('Key')).toHaveAccessibleDescription('This option key is used twice.')
    expect(within(group('Option 1', group('Attribute 2', attributes))).getByLabelText('Key')).not.toHaveAccessibleDescription()
    expect(within(group('Attribute 3', attributes)).getByLabelText('Maximum items')).toHaveAccessibleDescription(
      /The maximum must not be below the minimum/,
    )
    const instance = screen.getByRole('region', { name: 'Instance attributes' })
    expect(own(group('Attribute 1', instance), 'Key')).toHaveAccessibleDescription('This key is used twice.')
    expect(screen.queryByText('list page')).not.toBeInTheDocument()
  })

  it('checks the obvious rules before saving', async () => {
    let called = false
    server.use(
      http.post('/api/product-types', () => {
        called = true
        return HttpResponse.json(existing, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/product-types/new' })

    await u.type(await screen.findByLabelText('Key'), 'Bad Key')
    const attributes = screen.getByRole('region', { name: 'Attributes' })
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const row = group('Attribute 1', attributes)
    await u.type(own(row, 'Key'), 'width')
    await u.selectOptions(within(row).getByLabelText('Type'), 'number')
    await u.type(within(row).getByLabelText('Minimum'), '10')
    await u.type(within(row).getByLabelText('Maximum'), '2')
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const choice = group('Attribute 2', attributes)
    await u.type(own(choice, 'Key'), 'width')
    await u.selectOptions(within(choice).getByLabelText('Type'), 'enum')

    await u.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('The maximum must not be below the minimum.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Basics' })).getByLabelText('Key')).toHaveAccessibleDescription(
      'Use lower case letters, digits and underscores, starting with a letter.',
    )
    expect(screen.getByLabelText('Name (English)')).toHaveAccessibleDescription('This field is required.')
    expect(own(row, 'Label (English)')).toHaveAccessibleDescription('An English label is required.')
    expect(within(row).getByLabelText('Maximum')).toHaveAccessibleDescription('The maximum must not be below the minimum.')
    expect(own(choice, 'Key')).toHaveAccessibleDescription('This key is used twice.')
    expect(within(choice).getByText('Add at least one option.')).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('removes and reorders attributes', async () => {
    let put: { attributes: { key: string }[] } | undefined
    server.use(
      http.get('/api/product-types/:id', () => HttpResponse.json(existing)),
      http.put('/api/product-types/:id', async ({ request }) => {
        put = (await request.json()) as typeof put
        return HttpResponse.json(existing)
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: `/catalog/product-types/${existing.id}` })

    const attributes = await screen.findByRole('region', { name: 'Attributes' })
    expect(within(group('Attribute 1', attributes)).getAllByRole('button', { name: 'Move up' })[0]).toBeDisabled()
    await u.click(within(group('Attribute 3', attributes)).getAllByRole('button', { name: 'Move up' })[0])
    await u.click(within(group('Attribute 1', attributes)).getAllByRole('button', { name: 'Remove' })[0])
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(put?.attributes.map((a) => a.key)).toEqual(['protocols', 'colour']))
  })

  it('shows the product type read-only without catalog.write', async () => {
    server.use(http.get('/api/product-types/:id', () => HttpResponse.json({ ...existing, can: { update: false, delete: false } })))
    renderRoutes(routes, { me: userMe, route: `/catalog/product-types/${existing.id}` })

    expect(await screen.findByRole('heading', { name: 'Dimmer actuator' })).toBeInTheDocument()
    expect(screen.getByText('You can view this product type but not change it.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Basics' })).getByLabelText('Key')).toBeDisabled()
    const width = group('Attribute 1', screen.getByRole('region', { name: 'Attributes' }))
    expect(own(width, 'Key')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /update|add attribute|remove|move/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/product-types')
  })

  it('does not offer creating to users without catalog.write', async () => {
    renderRoutes(appRoutes, { me: userMe, route: '/catalog/product-types/new' })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
  })

  it('cancel returns to the list without saving', async () => {
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/product-types/new' })

    await u.type(await screen.findByLabelText('Key'), 'draft')
    await u.click(screen.getByRole('link', { name: 'Cancel' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('shows when the product type does not exist', async () => {
    server.use(http.get('/api/product-types/:id', () => problem(404, { code: 'product_type.not_found' })))
    renderRoutes(routes, { me: adminMe, route: `/catalog/product-types/${existing.id}` })

    expect(await screen.findByRole('alert')).toHaveTextContent('This product type no longer exists.')
  })
})
