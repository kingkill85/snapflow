import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { ProductType, ProductTypeInput, ProductTypeUpdate } from '@/api/generated/model'
import { getSearchVariantsQueryKey } from '@/api/generated/products/products'
import { adminMe, userMe } from '@/test/fixtures'
import { translation } from '@/test/translatable'
import { renderWithProviders } from '@/test/render'
import { chooseOption } from '@/test/select'
import { server } from '@/test/server'

import { ProductTypesPage } from './ProductTypesPage'

const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const productType = (over: Partial<ProductType>): ProductType => ({
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'zigbee',
  name: { en: 'Zigbee', de: 'Zigbee' },
  sortOrder: 1,
  reservePercent: 20,
  nominalVoltage: 230,
  topology: 'none',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
  ...over,
})

const alpha = productType({ abbreviation: 'ZB', color: '#1f6feb', topology: 'bus', defaultBusCurrentMa: 10, reservePercent: 25, busDevicesMax: 64, nominalVoltage: 110 })
const beta = productType({
  id: '6f1c2b8e-0000-4000-8000-000000000002',
  key: 'knx',
  name: { en: 'KNX' },
  sortOrder: 2,
  isActive: false,
})
const gamma = productType({
  id: '6f1c2b8e-0000-4000-8000-000000000003',
  key: 'hdl_buspro',
  name: { en: 'HDL Buspro' },
  sortOrder: 3,
})

/** The API: inactive types only with includeInactive=true. */
function listHandler(all: () => ProductType[], requested: string[] = []) {
  return http.get('/api/product-types', ({ request }) => {
    const url = new URL(request.url)
    requested.push(url.search)
    const items = url.searchParams.get('includeInactive') === 'true' ? all() : all().filter((p) => p.isActive)
    return HttpResponse.json({ items })
  })
}

const row = (name: string) => screen.getByText(name).closest('tr')!
const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent)

describe('ProductTypesPage', () => {
  it('lists active product types with their badge and shows inactive ones on request', async () => {
    const requested: string[] = []
    server.use(listHandler(() => [alpha, beta, gamma], requested))
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await screen.findByText('Zigbee')
    const zigbee = row('Zigbee')
    expect(within(zigbee).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', 'ZBZigbee', 'zigbee', 'Active', expect.any(String)])
    // The abbreviation on the badge colour, its text black or white for contrast.
    expect(within(zigbee).getByTestId('type-abbreviation')).toHaveStyle({ backgroundColor: '#1f6feb', color: '#ffffff' })
    expect(screen.queryByText('KNX')).not.toBeInTheDocument()
    expect(requested).toEqual([''])
    // The position among the rows shown, not the stored sortOrder (gamma is 3, beta is hidden).
    const hdl = row('HDL Buspro')
    expect(within(hdl).getAllByRole('cell')[0]).toHaveTextContent('2')
    // Without abbreviation a dot; without colour it is outlined.
    expect(within(hdl).getByTestId('type-color')).not.toHaveAttribute('style')

    await u.click(screen.getByLabelText('Show inactive'))

    const knx = (await screen.findByText('KNX')).closest('tr')!
    expect(within(knx).getByText('Inactive')).toBeInTheDocument()
    expect(within(knx).getAllByRole('cell')[0]).toHaveTextContent('2')
    expect(requested).toContain('?includeInactive=true')
  })

  it('is read-only without catalog.write', async () => {
    server.use(listHandler(() => [alpha, gamma].map((p) => ({ ...p, can: { update: false, delete: false } }))))
    renderWithProviders(<ProductTypesPage />, { me: userMe })

    expect(await screen.findByText('Zigbee')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('offers edit, delete and moves to writers; first up and last down are disabled', async () => {
    server.use(listHandler(() => [alpha, gamma]))
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    expect(await screen.findByRole('button', { name: 'Move Zigbee up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Zigbee down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move HDL Buspro up' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move HDL Buspro down' })).toBeDisabled()
    expect(within(row('Zigbee')).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(row('Zigbee')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New product type' })).toBeInTheDocument()
  })

  it('creates a product type in a dialog with a badge preview of the stored abbreviation', async () => {
    let all = [alpha]
    let posted: ProductTypeInput | undefined
    server.use(
      listHandler(() => all),
      http.post('/api/product-types', async ({ request }) => {
        posted = (await request.json()) as ProductTypeInput
        const created = productType({ id: '6f1c2b8e-0000-4000-8000-000000000009', key: 'knx', name: { en: 'KNX' }, abbreviation: 'KNX', color: '#ffcc00' })
        all = [...all, created]
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    const { client } = renderWithProviders(<ProductTypesPage />, { me: adminMe })
    client.setQueryData(getSearchVariantsQueryKey({ search: 'x' }), { items: [], total: 0 })

    await u.click(await screen.findByRole('button', { name: 'New product type' }))
    const dialog = await screen.findByRole('dialog', { name: 'New product type' })
    const preview = within(dialog).getByTestId('badge-preview')
    // An empty form previews a dot and a placeholder name.
    expect(preview).toHaveTextContent('Name')
    expect(within(preview).getByTestId('type-color')).toBeInTheDocument()

    await u.type(within(dialog).getByLabelText('Key'), 'knx')
    await u.type((await translation(u, dialog, 'Name', 'en')), 'KNX')
    await u.type(within(dialog).getByLabelText('Abbreviation'), ' knx ')
    await u.type(within(dialog).getByLabelText('Colour'), '#FFCC00')
    // The defaults shown follow the topology.
    expect(within(dialog).queryByLabelText('Default bus current')).not.toBeInTheDocument()
    await chooseOption(u, within(dialog).getByLabelText('Topology'), 'Wireless')
    expect(within(dialog).queryByLabelText('Devices per line')).not.toBeInTheDocument()
    await u.type(within(dialog).getByLabelText('Default wireless places'), '1')
    // The preview follows the form; a light colour gets black text.
    expect(preview).toHaveTextContent('KNXKNX')
    expect(within(preview).getByTestId('type-abbreviation')).toHaveStyle({ backgroundColor: '#FFCC00', color: '#000000' })

    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Sent as typed (trimmed): the server normalises it.
    expect(posted).toEqual({
      key: 'knx',
      name: { en: 'KNX' },
      abbreviation: 'knx',
      color: '#ffcc00',
      defaultBusCurrentMa: 0,
      reservePercent: 20,
      busDevicesMax: 0,
      nominalVoltage: 230,
      topology: 'wireless',
      defaultWirelessPlacesUsed: 1,
      isActive: true,
    })
    await waitFor(() => expect(names()).toEqual(['ZBZigbee', 'KNXKNX']))
    // Products show their type's badge: the add-on picker refetches.
    expect(client.getQueryState(getSearchVariantsQueryKey({ search: 'x' }))?.isInvalidated).toBe(true)
  })

  it('previews the abbreviation as the server stores it and counts characters, not UTF-16 units', async () => {
    server.use(listHandler(() => []))
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })
    await u.click((await screen.findAllByRole('button', { name: 'New product type' }))[0])
    const dialog = await screen.findByRole('dialog')
    // "ß" has no single upper-case character: kept, as Go's strings.ToUpper does.
    await u.type(within(dialog).getByLabelText('Abbreviation'), ' straße ')
    expect(within(dialog).getByTestId('type-abbreviation')).toHaveTextContent('STRAßE')
    // Six characters outside the BMP are 12 UTF-16 units, still within the limit.
    await u.clear(within(dialog).getByLabelText('Abbreviation'))
    await u.type(within(dialog).getByLabelText('Abbreviation'), '𝐀𝐁𝐂𝐃𝐄𝐅')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(within(dialog).getByLabelText('Abbreviation')).not.toHaveAccessibleDescription(/too long/)
  })

  it('checks key, name, abbreviation and colour before saving', async () => {
    let posted = false
    server.use(
      listHandler(() => []),
      http.post('/api/product-types', () => {
        posted = true
        return HttpResponse.json(alpha, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    // The empty state offers creating too.
    expect(await screen.findByText('No product types yet.')).toBeInTheDocument()
    await u.click(screen.getAllByRole('button', { name: 'New product type' })[0])
    const dialog = await screen.findByRole('dialog')
    await u.type(within(dialog).getByLabelText('Key'), 'Zig Bee')
    await u.type(within(dialog).getByLabelText('Abbreviation'), 'TOOLONG')
    await u.type(within(dialog).getByLabelText('Colour'), 'blue')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(within(dialog).getByLabelText('Key')).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
    expect(await translation(u, dialog, 'Name', 'en')).toHaveAccessibleDescription('This field is required.')
    expect(within(dialog).getByLabelText('Abbreviation')).toHaveAccessibleDescription('This value is too long (at most 6 characters).')
    expect(within(dialog).getByLabelText('Colour')).toHaveAccessibleDescription('Enter a colour as #rrggbb, e.g. #1f6feb.')
    expect(posted).toBe(false)
  })

  it('shows server errors at their fields, a taken key at the key', async () => {
    server.use(
      listHandler(() => [alpha]),
      http.post('/api/product-types', () => problem(409, { code: 'product_type.key_taken', params: { key: 'zigbee' } })),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await u.click(await screen.findByRole('button', { name: 'New product type' }))
    const dialog = await screen.findByRole('dialog')
    await u.type(within(dialog).getByLabelText('Key'), 'zigbee')
    await u.type((await translation(u, dialog, 'Name', 'en')), 'Zigbee')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The key "zigbee" is already used.')
    expect(within(dialog).getByLabelText('Key')).toHaveAccessibleDescription('The key "zigbee" is already used.')

    server.use(
      http.post('/api/product-types', () =>
        problem(422, {
          code: 'validation.failed',
          fields: [{ location: 'body.abbreviation', code: 'validation.control_chars' }],
        }),
      ),
    )
    await u.clear(within(dialog).getByLabelText('Key'))
    await u.type(within(dialog).getByLabelText('Key'), 'zigbee_2')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Abbreviation')).toHaveAccessibleDescription(
        'Control characters (such as tabs, line breaks or invisible characters) are not allowed.',
      ),
    )
  })

  it('updates a product type with the version it was opened with, and reloads after someone else changed it', async () => {
    let current = alpha
    const puts: ProductTypeUpdate[] = []
    server.use(
      listHandler(() => [current, gamma]),
      http.put('/api/product-types/:id', async ({ request }) => {
        const body = (await request.json()) as ProductTypeUpdate
        puts.push(body)
        if (body.expectedUpdatedAt !== current.updatedAt) return problem(409, { code: 'product_type.stale' })
        current = { ...current, ...body, updatedAt: '2026-01-03T00:00:00Z' }
        return HttpResponse.json(current)
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await screen.findByText('Zigbee')
    await u.click(within(row('Zigbee')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit product type' })
    expect(within(dialog).getByLabelText('Key')).toHaveValue('zigbee')
    expect(within(dialog).getByLabelText('Abbreviation')).toHaveValue('ZB')
    expect(within(dialog).getByLabelText('Colour')).toHaveValue('#1f6feb')
    expect(within(dialog).getByLabelText('Active')).toBeChecked()
    expect(within(dialog).getByLabelText('Default bus current')).toHaveValue('10')
    expect(within(dialog).getByLabelText(/^Reserve/)).toHaveValue('25')
    expect(within(dialog).getByLabelText('Devices per line')).toHaveValue('64')

    // Someone else saves meanwhile.
    current = { ...alpha, name: { en: 'Zigbee 3.0' }, updatedAt: '2026-01-02T00:00:00Z' }
    await u.clear(within(dialog).getByLabelText('Abbreviation'))
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed this product type in the meantime.')
    // The stored system settings are sent along (D294).
    expect(puts[0]).toEqual({
      key: 'zigbee',
      name: { en: 'Zigbee', de: 'Zigbee' },
      color: '#1f6feb',
      defaultBusCurrentMa: 10,
      reservePercent: 25,
      busDevicesMax: 64,
      nominalVoltage: 110,
      topology: 'bus',
      defaultWirelessPlacesUsed: 0,
      isActive: true,
      expectedUpdatedAt: alpha.updatedAt,
    })

    // Reload starts over from the current version.
    await u.click(within(alert).getByRole('button', { name: 'Reload' }))
    await waitFor(async () => expect(await translation(u, dialog, 'Name', 'en')).toHaveValue('Zigbee 3.0'))
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await u.click(within(dialog).getByLabelText('Active'))
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(puts[1]).toMatchObject({ name: { en: 'Zigbee 3.0' }, abbreviation: 'ZB', isActive: false, expectedUpdatedAt: '2026-01-02T00:00:00Z' })
  })

  it('reorders with the full id list, inactive types included', async () => {
    let all = [alpha, beta, gamma]
    let sent: unknown
    server.use(
      listHandler(() => all),
      http.put('/api/product-types/order', async ({ request }) => {
        sent = await request.json()
        const ids = (sent as { ids: string[] }).ids
        all = ids.map((id, i) => ({ ...all.find((p) => p.id === id)!, sortOrder: i + 1 }))
        return HttpResponse.json({ items: all })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    // Only alpha and gamma are shown; gamma moves above alpha, beta keeps its place after alpha.
    await u.click(await screen.findByRole('button', { name: 'Move HDL Buspro up' }))

    await waitFor(() => expect(sent).toEqual({ ids: [gamma.id, alpha.id, beta.id] }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move HDL Buspro up' })).toBeDisabled())
    expect(names()).toEqual(['HDL Buspro', 'ZBZigbee'])
  })

  it('applies the move again when a type was added between the fetch and the save', async () => {
    const delta = productType({ id: '6f1c2b8e-0000-4000-8000-000000000004', key: 'delta', name: { en: 'Delta' }, sortOrder: 4 })
    let all = [alpha, gamma]
    const sent: unknown[] = []
    server.use(
      listHandler(() => all),
      http.put('/api/product-types/order', async ({ request }) => {
        const body = (await request.json()) as { ids: string[] }
        sent.push(body)
        // Someone else created delta after the first fetch.
        if (sent.length === 1) {
          all = [alpha, gamma, delta]
          return problem(422, { code: 'product_type.order_mismatch' })
        }
        all = body.ids.map((id, i) => ({ ...all.find((p) => p.id === id)!, sortOrder: i + 1 }))
        return HttpResponse.json({ items: all })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await u.click(await screen.findByRole('button', { name: 'Move HDL Buspro up' }))

    await waitFor(() => expect(sent).toEqual([{ ids: [gamma.id, alpha.id] }, { ids: [gamma.id, alpha.id, delta.id] }]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move HDL Buspro up' })).toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sends nothing when the visible neighbour is gone from the fresh list', async () => {
    let all = [alpha, gamma]
    let sent = false
    server.use(
      listHandler(() => all),
      http.put('/api/product-types/order', () => {
        sent = true
        return HttpResponse.json({ items: all })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })
    const button = await screen.findByRole('button', { name: 'Move Zigbee down' })
    all = [alpha]

    await u.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent('The product types have changed in the meantime.')
    expect(sent).toBe(false)
  })

  it('shows that a product type in use cannot be deleted, and deletes one that is not', async () => {
    let all = [alpha, gamma]
    server.use(
      listHandler(() => all),
      http.delete('/api/product-types/:id', ({ params }) => {
        if (params.id === alpha.id) return problem(409, { code: 'product_type.in_use' })
        all = all.filter((p) => p.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await u.click(within(await screen.findByText('Zigbee').then((e) => e.closest('tr')!)).getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete "Zigbee"?')
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This product type is still used by products or projects. Deactivate it instead.')
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await u.click(within(row('HDL Buspro')).getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('dialog')
    // A new attempt starts without the previous error.
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('HDL Buspro')).not.toBeInTheDocument())
    expect(screen.getByText('Zigbee')).toBeInTheDocument()
  })
})
