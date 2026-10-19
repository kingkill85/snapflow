import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { problem } from '@/features/projects/test-fixtures'
import { chooseOption } from '@/test/select'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { PricingTab } from './PricingTab'
import { bom, versionId } from './test-fixtures'

function serve() {
  const previews: unknown[] = []
  server.use(
    http.get('/api/versions/:versionId/pricing', () => HttpResponse.json(bom.pricing)),
    http.post('/api/versions/:versionId/pricing/preview', async ({ request }) => {
      const body = (await request.json()) as { discountValue: string }
      previews.push(body)
      // The API computes; the mock only echoes something recognisable.
      return HttpResponse.json({ ...bom.totals, discount: body.discountValue === '15' ? '38.25' : bom.totals.discount, grandTotal: body.discountValue === '15' ? '266.75' : bom.totals.grandTotal })
    }),
  )
  return previews
}

describe('PricingTab', () => {
  it('shows the saved values and the totals from the preview', async () => {
    serve()
    renderWithProviders(<PricingTab versionId={versionId} canWrite />)
    expect(await screen.findByRole('combobox', { name: 'Discount' })).toHaveTextContent('Percent')
    expect(screen.getByRole('textbox', { name: /^Discount value/ })).toHaveValue('10')
    expect(screen.getByRole('combobox', { name: 'Services' })).toHaveTextContent('Amount (USD)')
    expect(screen.getByRole('textbox', { name: /^Services value/ })).toHaveValue('50')
    const totals = await screen.findByRole('region', { name: 'Totals with these values' })
    expect(within(totals).getByTestId('total-grandTotal')).toHaveTextContent('$279.50')
    expect(within(totals).getByTestId('total-services')).toHaveTextContent('Programming')
  })

  it('previews unsaved values (debounced) and saves them', async () => {
    const previews = serve()
    let saved: unknown
    server.use(
      http.put('/api/versions/:versionId/pricing', async ({ request }) => {
        saved = await request.json()
        return HttpResponse.json({ ...bom, pricing: { ...bom.pricing, discountValue: '15', updatedAt: '2026-10-19T11:00:00Z' } })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PricingTab versionId={versionId} canWrite />)
    const discount = await screen.findByRole('textbox', { name: /^Discount value/ })
    await user.clear(discount)
    await user.type(discount, '15')
    const totals = screen.getByRole('region', { name: 'Totals with these values' })
    await waitFor(() => expect(within(totals).getByTestId('total-grandTotal')).toHaveTextContent('$266.75'), { timeout: 2000 })
    // Not one request per keystroke.
    expect(previews.filter((p) => (p as { discountValue: string }).discountValue === '1')).toHaveLength(0)

    await chooseOption(user, screen.getByRole('combobox', { name: 'Services' }), 'None')
    expect(screen.queryByRole('textbox', { name: /^Services value/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Pricing saved.')).toBeInTheDocument()
    expect(saved).toEqual({
      discountKind: 'percent',
      discountValue: '15',
      servicesKind: 'none',
      servicesValue: '0',
      servicesLabel: { en: 'Programming', de: 'Programmierung' },
      expectedUpdatedAt: bom.pricing.updatedAt,
    })
  })

  it('shows API errors at their fields and a stale save', async () => {
    serve()
    let calls = 0
    server.use(
      http.put('/api/versions/:versionId/pricing', () => {
        calls++
        return calls === 1
          ? problem(422, { code: 'validation.failed', fields: [{ location: 'body.discountValue', code: 'pricing.percent_range', params: { max: 100 } }] })
          : problem(409, { code: 'pricing.stale' })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PricingTab versionId={versionId} canWrite />)
    const discount = await screen.findByRole('textbox', { name: /^Discount value/ })
    await user.clear(discount)
    await user.type(discount, '150')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(discount).toHaveAttribute('aria-invalid', 'true'))

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/changed the pricing|inzwischen|meantime/)).toBeInTheDocument()
  })

  it('is read-only without write access', async () => {
    serve()
    renderWithProviders(<PricingTab versionId={versionId} canWrite={false} />)
    expect(await screen.findByRole('textbox', { name: /^Discount value/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
