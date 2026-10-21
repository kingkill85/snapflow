import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { getGetBomQueryKey } from '@/api/generated/bom/bom'
import type { Bom } from '@/api/generated/model'
import { problem } from '@/features/projects/test-fixtures'
import { chooseOption } from '@/test/select'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { BomTab } from './BomTab'
import { bom, bomEur, changes, dimmer, manualBattery, manualCabling, motion, projectId, versionId } from './test-fixtures'

function serve(data: Bom = bom) {
  let gets = 0
  server.use(
    http.get('/api/versions/:versionId/bom', () => {
      gets++
      return HttpResponse.json(data)
    }),
    http.get('/api/versions/:versionId/manual-lines', () => HttpResponse.json(data.manualLines)),
    http.get('/api/versions/:versionId/pricing', () => HttpResponse.json(data.pricing)),
    http.get('/api/versions/:versionId/catalog-changes', () => HttpResponse.json(changes)),
  )
  return { gets: () => gets }
}

const render = (canWrite = true) => renderWithProviders(<BomTab projectId={projectId} versionId={versionId} canWrite={canWrite} productTypeIds={[]} />)
const table = () => screen.getByRole('table', { name: 'Bill of materials' })
const row = (name: string) => within(table()).getByText(name).closest('tr')!

describe('BomTab', () => {
  it('groups lines by product type and category with the API subtotals, one quantity column per plan', async () => {
    serve()
    render()
    await screen.findByRole('table', { name: 'Bill of materials' })
    const headers = within(table()).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Image', 'Product', 'Ground floor', 'Upper floor', 'Manual', 'Qty', 'Unit price', 'Total'])
    const rows = within(table()).getAllByRole('row').map((r) => r.textContent)
    // System, then its categories, each with its subtotal; free text last.
    expect(rows[1]).toContain('Zigbee')
    expect(rows[1]).toContain('$155.00')
    expect(rows[2]).toContain('Sensors')
    expect(rows[2]).toContain('$115.00')
    expect(rows[3]).toContain('Motion sensor')
    expect(rows[4]).toContain('Battery')
    expect(rows[4]).toContain('Add-on for Motion sensor')
    expect(rows[5]).toContain('Switches')
    expect(rows[7]).toContain('Other items')
    expect(rows[8]).toContain('Cabling')
    const cells = within(row('Battery')).getAllByRole('cell').map((c) => c.textContent)
    expect(cells.slice(2)).toEqual(['3', '1', '2', '6', '$2.50', '$15.00'])
    // Per plan and manual, 0 is an empty cell; the total quantity stays a number.
    const free = within(row('Cabling')).getAllByRole('cell').map((c) => c.textContent)
    expect(free.slice(2)).toEqual(['', '', '1', '1', '$100.00', '$100.00'])

    const totals = screen.getByRole('region', { name: 'Totals' })
    expect(within(totals).getByTestId('total-subtotal')).toHaveTextContent('$255.00')
    expect(within(totals).getByTestId('total-discount')).toHaveTextContent('\u2212$25.50')
    expect(within(totals).getByTestId('total-services')).toHaveTextContent('Programming$50.00')
    expect(within(totals).getByTestId('total-grandTotal')).toHaveTextContent('$279.50')
  })

  it('filters by plan and zone with the API quantities and hides the money that is not filtered', async () => {
    serve()
    const user = userEvent.setup()
    render()
    await screen.findByRole('table', { name: 'Bill of materials' })
    expect(screen.getByRole('combobox', { name: 'Zone' })).toBeDisabled()

    await chooseOption(user, screen.getByRole('combobox', { name: 'Plan' }), 'Ground floor')
    expect(screen.getByText(/Prices and totals are for the whole version/)).toBeInTheDocument()
    expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Image', 'Product', 'Ground floor', 'Unit price'])
    expect(within(table()).queryByText('Dimmer')).not.toBeInTheDocument()
    expect(within(table()).queryByText('Cabling')).not.toBeInTheDocument()
    expect(within(row('Motion sensor')).getAllByRole('cell')[2]).toHaveTextContent('3')
    expect(within(table()).queryByText('$115.00')).not.toBeInTheDocument()

    await chooseOption(user, screen.getByRole('combobox', { name: 'Zone' }), 'Kitchen')
    expect(within(row('Motion sensor')).getAllByRole('cell')[2]).toHaveTextContent('2')
    await chooseOption(user, screen.getByRole('combobox', { name: 'Zone' }), 'No zone')
    expect(within(row('Motion sensor')).getAllByRole('cell')[2]).toHaveTextContent('1')

    await chooseOption(user, screen.getByRole('combobox', { name: 'Plan' }), 'Upper floor')
    expect(within(table()).getByText('Dimmer')).toBeInTheDocument()
  })

  it('shows converted amounts for a project currency other than USD', async () => {
    serve(bomEur)
    render()
    await screen.findByRole('table', { name: 'Bill of materials' })
    expect(within(row('Motion sensor')).getByText('€90.00')).toBeInTheDocument()
    expect(within(row('Motion sensor')).getByText('€22.50')).toBeInTheDocument()
    expect(screen.getByTestId('total-grandTotal')).toHaveTextContent('$279.50€251.55')
    expect(screen.getByText('Exchange rate: 1 USD = 0.9 EUR')).toBeInTheDocument()
    expect(screen.getByTestId('total-discount')).toHaveTextContent('\u2212$25.50\u2212€22.95')
    // Manual lines show the API's converted amounts like the BOM lines.
    const manual = screen.getByRole('table', { name: 'Manual lines' })
    const cabling = within(manual).getByText('Cabling').closest('tr')!
    expect(within(cabling).getAllByRole('cell').map((c) => c.textContent).slice(1, 4)).toEqual(['1', '$100.00€90.00', '$100.00€90.00'])
  })

  it('marks statuses and updates from the catalog', async () => {
    const { gets } = serve()
    let applied: unknown
    server.use(
      http.post('/api/versions/:versionId/catalog-changes/apply', async ({ request }) => {
        applied = await request.json()
        return HttpResponse.json({ updated: [changes.items[0].variantId], skipped: [] })
      }),
    )
    const user = userEvent.setup()
    render()
    await screen.findByRole('table', { name: 'Bill of materials' })
    expect(within(row('Motion sensor')).getByText('Outdated')).toBeInTheDocument()
    expect(within(row('Battery')).getByText('Deleted')).toBeInTheDocument()

    await user.click(within(row('Motion sensor')).getByRole('button', { name: 'Outdated – update from catalog: Motion sensor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update from catalog' })
    expect(await within(dialog).findByText('Grand total $279.50 → $297.50 if everything is updated')).toBeInTheDocument()
    const motion = within(dialog).getByRole('checkbox', { name: 'Motion sensor' })
    expect(motion).toBeChecked()
    expect(within(dialog).getByText('Effect on the grand total: +$18.00')).toBeInTheDocument()
    expect(within(dialog).getByText('$25.00')).toBeInTheDocument()
    expect(within(dialog).getByText('$30.00')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Battery' })).toBeDisabled()
    expect(within(dialog).getByText('Deleted from the catalog: stays as quoted')).toBeInTheDocument()

    const before = gets()
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(applied).toEqual({ variantIds: [changes.items[0].variantId] })
    expect(gets()).toBeGreaterThan(before)
  })

  it('names the statuses in the update button and offers it only for outdated lines', async () => {
    serve({
      ...bom,
      lines: bom.lines.map((l) =>
        l.key === motion.key
          ? { ...l, status: { available: false, deleted: false, inactive: true, outdated: true } }
          : l.key === dimmer.key
            ? { ...l, status: { available: false, deleted: false, inactive: true, outdated: false } }
            : l,
      ),
    })
    render()
    await screen.findByRole('table', { name: 'Bill of materials' })
    expect(within(row('Motion sensor')).getByRole('button', { name: 'Inactive, Outdated – update from catalog: Motion sensor' })).toBeInTheDocument()
    // Inactive only, or deleted: nothing to take over, plain badges.
    expect(within(row('Dimmer')).getByText('Inactive')).toBeInTheDocument()
    expect(within(row('Dimmer')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(row('Battery')).getByText('Deleted')).toBeInTheDocument()
    expect(within(row('Battery')).queryByRole('button')).not.toBeInTheDocument()
  })

  it('applies only the selected changes, by id', async () => {
    const dimmerChange = { ...changes.items[0], variantId: dimmer.key, productId: dimmer.productId!, snapshot: dimmer.snapshot }
    serve()
    server.use(http.get('/api/versions/:versionId/catalog-changes', () => HttpResponse.json({ ...changes, items: [changes.items[0], dimmerChange, changes.items[1]] })))
    let applied: unknown
    server.use(
      http.post('/api/versions/:versionId/catalog-changes/apply', async ({ request }) => {
        applied = await request.json()
        return HttpResponse.json({ updated: [dimmer.key], skipped: [] })
      }),
    )
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'Update from catalog' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update from catalog' })
    const all = await within(dialog).findByRole('checkbox', { name: 'Select all' })
    expect(all).toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Motion sensor' }))
    expect(all).not.toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Dimmer' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(applied).toEqual({ variantIds: [dimmer.key] }))

    // Everything selected is still sent as ids, never as "all".
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Update from catalog' }))
    const again = await screen.findByRole('dialog', { name: 'Update from catalog' })
    await within(again).findByRole('checkbox', { name: 'Select all' })
    await user.click(within(again).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(applied).toEqual({ variantIds: [motion.key, dimmer.key] }))
  })

  it('hides a zero discount and zero services in the totals', async () => {
    serve({ ...bom, totals: { ...bom.totals, discount: '0.00', services: '0.00', grandTotal: '255.00' } })
    render()
    const totals = await screen.findByRole('region', { name: 'Totals' })
    expect(within(totals).getByTestId('total-subtotal')).toHaveTextContent('$255.00')
    expect(within(totals).queryByTestId('total-discount')).not.toBeInTheDocument()
    expect(within(totals).queryByTestId('total-services')).not.toBeInTheDocument()
    expect(within(totals).getByTestId('total-grandTotal')).toHaveTextContent('$255.00')
  })

  it('shows the empty state without filters or update for an empty BOM', async () => {
    serve({ ...bom, lines: [], groups: [], manualLines: [] })
    render()
    expect(await screen.findByText('Nothing to list yet: place products in a plan or add a manual line.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Plan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update from catalog' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add product' })).toBeInTheDocument()
  })

  it('links a placement without snapshot to its plan', async () => {
    serve({ ...bom, warnings: [{ code: 'placement_without_snapshot', planId: bom.plans[0].id, placementId: 'p1' }] })
    render()
    expect(await screen.findByText('A placement on “Ground floor” has no price snapshot and is not counted.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open plan' })).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/plans/${bom.plans[0].id}`)
  })

  it('is view-only without write access', async () => {
    serve()
    render(false)
    await screen.findByRole('table', { name: 'Bill of materials' })
    expect(screen.queryByRole('button', { name: 'Update from catalog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Update from catalog:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Manual lines' })).toHaveTextContent('Cabling')
  })
})

describe('Manual lines', () => {
  it('adds a free-text line with a decimal comma', async () => {
    serve()
    let posted: unknown
    server.use(
      http.post('/api/versions/:versionId/manual-lines', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(manualCabling)
      }),
    )
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'Add free-text line' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add free-text line' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'Cabling')
    await user.type(within(dialog).getByLabelText(/^Unit price/), '12,5')
    await user.clear(within(dialog).getByLabelText(/^Quantity/))
    await user.type(within(dialog).getByLabelText(/^Quantity/), '3')
    await user.type(within(dialog).getByLabelText(/^Note/), 'Cat 7')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ name: 'Cabling', unitPrice: '12.5', quantity: 3, note: 'Cat 7' })
  })

  it('checks quantity and price before sending', async () => {
    serve()
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'Add free-text line' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add free-text line' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'X')
    await user.type(within(dialog).getByLabelText(/^Unit price/), '1,234')
    await user.clear(within(dialog).getByLabelText(/^Quantity/))
    await user.type(within(dialog).getByLabelText(/^Quantity/), '0')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText(/1 to 100,000/)).toBeInTheDocument()
  })

  it('edits a line with its updatedAt and shows a stale error', async () => {
    serve()
    let body: unknown
    server.use(
      http.put('/api/versions/:versionId/manual-lines/:id', async ({ request }) => {
        body = await request.json()
        return problem(409, { code: 'bom.line_stale' })
      }),
    )
    const user = userEvent.setup()
    render()
    await screen.findByRole('table', { name: 'Manual lines' })
    await user.click(screen.getByRole('button', { name: 'Edit Cabling' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit line' })
    await user.clear(within(dialog).getByLabelText(/^Quantity/))
    await user.type(within(dialog).getByLabelText(/^Quantity/), '2')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await within(dialog).findByText(/Someone else has changed this line/)).toBeInTheDocument()
    expect(body).toEqual({ name: 'Cabling', unitPrice: '100.00', quantity: 2, note: 'Cat 7', expectedUpdatedAt: manualCabling.updatedAt })
  })

  it('edits a line with the fresh updatedAt, not a cached one (D44)', async () => {
    serve()
    let body: { expectedUpdatedAt?: string } | undefined
    server.use(
      http.put('/api/versions/:versionId/manual-lines/:id', async ({ request }) => {
        body = (await request.json()) as typeof body
        return HttpResponse.json(manualCabling)
      }),
    )
    const user = userEvent.setup()
    // The fresh copy arrives a moment later: the form must wait for it.
    server.use(
      http.get('/api/versions/:versionId/bom', async () => {
        await delay(150)
        return HttpResponse.json(bom)
      }),
    )
    // A previous visit left the line with an older updatedAt in the cache.
    const cached = { ...bom, manualLines: bom.manualLines.map((l) => ({ ...l, updatedAt: '2026-10-18T09:00:00Z' })) }
    renderWithProviders(<BomTab projectId={projectId} versionId={versionId} canWrite productTypeIds={[]} />, {
      prepare: (client) => client.setQueryData(getGetBomQueryKey(versionId), cached),
    })
    await user.click(await screen.findByRole('button', { name: 'Edit Cabling' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit line' })
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(body?.expectedUpdatedAt).toBe(manualCabling.updatedAt))
  })

  it('reorders and deletes lines', async () => {
    serve()
    let order: unknown
    let deleted = ''
    server.use(
      http.put('/api/versions/:versionId/manual-lines/order', async ({ request }) => {
        order = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
      http.delete('/api/versions/:versionId/manual-lines/:id', ({ params }) => {
        deleted = params.id as string
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    render()
    await screen.findByRole('table', { name: 'Manual lines' })
    await user.click(screen.getByRole('button', { name: 'Move Battery up' }))
    await waitFor(() => expect(order).toEqual({ ids: [manualBattery.id, manualCabling.id] }))

    await user.click(screen.getByRole('button', { name: 'Delete Cabling' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete line' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleted).toBe(manualCabling.id))
  })
})

describe('Manual catalog line', () => {
  it('picks a product of the project with a search and its variant', async () => {
    serve()
    const type = { id: 'pt1', key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb' }
    const category = { id: 'c1', name: { en: 'Sensors' } }
    const variant = (id: string, product: string, name: string, productTypeId = 'pt1') => ({
      id,
      available: true,
      category,
      categoryId: 'c1',
      modelNumber: `M-${product}`,
      name: { en: name },
      price: '10.00',
      productId: `p-${product}`,
      productName: { en: product },
      productType: type,
      productTypeId,
    })
    server.use(
      http.get('/api/variants', () =>
        HttpResponse.json({ items: [variant('v1', 'Motion', 'White'), variant('v2', 'Motion', 'Black'), variant('v3', 'Door', 'Std'), variant('v4', 'Other', 'X', 'pt2')], total: 4 }),
      ),
    )
    let posted: unknown
    server.use(
      http.post('/api/versions/:versionId/manual-lines', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(manualBattery)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<BomTab projectId={projectId} versionId={versionId} canWrite productTypeIds={['pt1']} />)
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add product' })
    expect(await within(dialog).findByRole('button', { name: /Door/ })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Other/ })).not.toBeInTheDocument()
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search' }), 'moti')
    expect(within(dialog).queryByRole('button', { name: /Door/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Motion/ }))
    expect(within(dialog).getByRole('combobox', { name: 'Variant' })).toHaveTextContent('White ($10.00)')
    await chooseOption(user, within(dialog).getByRole('combobox', { name: 'Variant' }), /Black/)
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(posted).toEqual({ variantId: 'v2', quantity: 1, note: '' }))
  })
  it('shows the API verdict on the chosen product at the picker', async () => {
    serve()
    const type = { id: 'pt1', key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb' }
    server.use(
      http.get('/api/variants', () =>
        HttpResponse.json({
          items: [
            {
              id: 'v3',
              available: true,
              category: { id: 'c1', name: { en: 'Sensors' } },
              categoryId: 'c1',
              modelNumber: 'M-Door',
              name: { en: 'Std' },
              price: '10.00',
              productId: 'p-door',
              productName: { en: 'Door' },
              productType: type,
              productTypeId: 'pt1',
            },
          ],
          total: 1,
        }),
      ),
      http.post('/api/versions/:versionId/manual-lines', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'body.variantId', code: 'bom.variant_unavailable' }] }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<BomTab projectId={projectId} versionId={versionId} canWrite productTypeIds={['pt1']} />)
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add product' })
    await user.click(await within(dialog).findByRole('button', { name: /Door/ }))
    // A single variant: no select, but its name and price.
    expect(within(dialog).queryByRole('combobox', { name: 'Variant' })).not.toBeInTheDocument()
    expect(within(dialog).getByTestId('chosen-variant')).toHaveTextContent('VariantStd ($10.00)')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('This product is not available (inactive) and cannot be added.')).toBeInTheDocument()
  })
})
