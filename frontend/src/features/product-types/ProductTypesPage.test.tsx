import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { ProductType } from '@/api/generated/model'
import { getGetProductTypeQueryKey } from '@/api/generated/product-types/product-types'
import { adminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProductTypesPage } from './ProductTypesPage'

const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const productType = (over: Partial<ProductType>): ProductType => ({
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'dimmer_actuator',
  name: { en: 'Dimmer actuator', de: 'Dimmaktor' },
  sortOrder: 1,
  isActive: true,
  attributes: [{ key: 'width_te', label: { en: 'Width' }, type: 'integer' }],
  instanceAttributes: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
  ...over,
})

const alpha = productType({ color: '#1f6feb' })
const beta = productType({
  id: '6f1c2b8e-0000-4000-8000-000000000002',
  key: 'gateway',
  name: { en: 'Gateway' },
  sortOrder: 2,
  isActive: false,
  attributes: [],
})
const gamma = productType({
  id: '6f1c2b8e-0000-4000-8000-000000000003',
  key: 'wall_switch',
  name: { en: 'Wall switch' },
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

describe('ProductTypesPage', () => {
  it('lists active product types and shows inactive ones on request', async () => {
    const requested: string[] = []
    server.use(listHandler(() => [alpha, beta, gamma], requested))
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    const row = (await screen.findByRole('link', { name: 'Dimmer actuator' })).closest('tr')!
    expect(within(row).getByText('dimmer_actuator')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', 'Dimmer actuator', 'dimmer_actuator', '1', 'Active', expect.any(String)])
    // The badge colour as a dot before the name; none is an empty outline.
    expect(within(row).getByTestId('type-color')).toHaveStyle({ backgroundColor: '#1f6feb' })
    expect(screen.queryByText('Gateway')).not.toBeInTheDocument()
    expect(requested).toEqual([''])
    // The position among the rows shown, not the stored sortOrder (gamma is 3, beta is hidden).
    const wallSwitch = screen.getByRole('link', { name: 'Wall switch' }).closest('tr')!
    expect(within(wallSwitch).getAllByRole('cell')[0]).toHaveTextContent('2')
    expect(within(wallSwitch).getByTestId('type-color')).not.toHaveAttribute('style')

    await u.click(screen.getByLabelText('Show inactive'))

    const gateway = (await screen.findByRole('link', { name: 'Gateway' })).closest('tr')!
    expect(within(gateway).getByText('Inactive')).toBeInTheDocument()
    expect(within(gateway).getAllByRole('cell')[0]).toHaveTextContent('2')
    expect(requested).toContain('?includeInactive=true')
  })

  it('is read-only without catalog.write, but links to the read-only detail page', async () => {
    server.use(listHandler(() => [alpha, gamma].map((p) => ({ ...p, can: { update: false, delete: false } }))))
    renderWithProviders(<ProductTypesPage />, { me: userMe })

    const link = await screen.findByRole('link', { name: 'Dimmer actuator' })
    expect(link).toHaveAttribute('href', `/catalog/product-types/${alpha.id}`)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /new product type/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /edit/i })).not.toBeInTheDocument()
  })

  it('offers edit, delete and moves to writers; first up and last down are disabled', async () => {
    server.use(listHandler(() => [alpha, gamma]))
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    expect(await screen.findByRole('button', { name: 'Move Dimmer actuator up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Dimmer actuator down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move Wall switch up' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move Wall switch down' })).toBeDisabled()
    const row = screen.getByRole('link', { name: 'Dimmer actuator' }).closest('tr')!
    expect(within(row).getByRole('link', { name: /edit/i })).toHaveAttribute('href', `/catalog/product-types/${alpha.id}`)
    expect(within(row).getByRole('button', { name: /delete/i })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /new product type/i })[0]).toHaveAttribute('href', '/catalog/product-types/new')
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
    await u.click(await screen.findByRole('button', { name: 'Move Wall switch up' }))

    await waitFor(() => expect(sent).toEqual({ ids: [gamma.id, alpha.id, beta.id] }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Wall switch up' })).toBeDisabled())
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('link')[0].textContent)
    expect(names).toEqual(['Wall switch', 'Dimmer actuator'])
  })

  it('moves down past the visible neighbour, keeping hidden inactive types in place', async () => {
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

    await u.click(await screen.findByRole('button', { name: 'Move Dimmer actuator down' }))

    await waitFor(() => expect(sent).toEqual({ ids: [beta.id, gamma.id, alpha.id] }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Dimmer actuator down' })).toBeDisabled())
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
    const button = await screen.findByRole('button', { name: 'Move Dimmer actuator down' })
    // Someone else deleted the wall switch meanwhile.
    all = [alpha]

    await u.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent('The product types have changed in the meantime.')
    expect(sent).toBe(false)
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Wall switch' })).not.toBeInTheDocument())
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

    await u.click(await screen.findByRole('button', { name: 'Move Wall switch up' }))

    await waitFor(() => expect(sent).toEqual([{ ids: [gamma.id, alpha.id] }, { ids: [gamma.id, alpha.id, delta.id] }]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Wall switch up' })).toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows reorder errors', async () => {
    server.use(
      listHandler(() => [alpha, gamma]),
      http.put('/api/product-types/order', () => problem(422, { code: 'product_type.order_mismatch' })),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await u.click(await screen.findByRole('button', { name: 'Move Dimmer actuator down' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The product types have changed in the meantime.')
  })

  it('shows that a product type in use cannot be deleted', async () => {
    let deleted = false
    server.use(
      listHandler(() => [alpha]),
      http.delete('/api/product-types/:id', () => {
        deleted = true
        return problem(409, { code: 'product_type.in_use' })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<ProductTypesPage />, { me: adminMe })

    await u.click(await screen.findByRole('button', { name: /delete/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete "Dimmer actuator"?')
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This product type is still used by products. Deactivate it instead.')
    expect(deleted).toBe(true)
  })

  it('deletes a product type', async () => {
    let all = [alpha, gamma]
    server.use(
      listHandler(() => all),
      http.delete('/api/product-types/:id', ({ params }) => {
        all = all.filter((p) => p.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    const { client } = renderWithProviders(<ProductTypesPage />, { me: adminMe })
    client.setQueryData(getGetProductTypeQueryKey(gamma.id), gamma)

    const row = (await screen.findByRole('link', { name: 'Wall switch' })).closest('tr')!
    await u.click(within(row).getByRole('button', { name: /delete/i }))
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByText('Wall switch')).not.toBeInTheDocument())
    expect(screen.getByText('Dimmer actuator')).toBeInTheDocument()
    // Its editor must not show it from the cache.
    expect(client.getQueryData(getGetProductTypeQueryKey(gamma.id))).toBeUndefined()
  })
})
