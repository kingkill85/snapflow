import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Project } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { PricingTab } from '@/features/bom/PricingTab'
import { bom, versionId } from '@/features/bom/test-fixtures'

import { ProjectFormDialog } from './ProjectFormDialog'
import { RateBar } from './RateBar'
import { currencies, problem, productTypes, villa } from './test-fixtures'

const online: Project = { ...villa, exchangeRate: '0.9237', exchangeRateSource: 'online', exchangeRateProvider: 'open.er-api.com', exchangeRateDate: '2026-10-18T00:00:00Z' }
const noRate: Project = { ...villa, exchangeRate: null, exchangeRateSource: 'none', exchangeRateDate: null }

function serveDialog() {
  const rateRequests: string[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: productTypes })),
    http.get('/api/currencies', () => HttpResponse.json(currencies)),
    http.get('/api/tenants', () => HttpResponse.json({ items: [] })),
    http.get('/api/exchange-rates/:currency', ({ params }) => {
      rateRequests.push(params.currency as string)
      if (params.currency === 'JPY') return problem(503, { code: 'exchange_rate.unavailable' })
      return HttpResponse.json({ currency: params.currency, rate: params.currency === 'PKR' ? '278.5' : '0.9237', date: '2026-10-18T00:00:00Z', provider: 'open.er-api.com' })
    }),
  )
  return rateRequests
}

function capturePut() {
  const sent: Record<string, unknown>[] = []
  server.use(
    http.put('/api/projects/:id', async ({ request }) => {
      sent.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json(villa)
    }),
  )
  return sent
}

describe('ProjectFormDialog exchange rate', () => {
  it('create: currency only, no rate field and no rate fetched', async () => {
    const requests = serveDialog()
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={null} />)
    const dialog = await screen.findByRole('dialog')
    const currency = within(dialog).getByRole('combobox', { name: /Currency/ })
    await user.click(currency)
    await user.keyboard('pak')
    await user.click(await screen.findByRole('option', { name: 'PKR – Pakistani Rupee' }))
    expect(within(dialog).queryByLabelText(/Exchange rate/)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Fetch current rate' })).not.toBeInTheDocument()
    expect(requests).toEqual([])
  })

  it('edit: shows the origin, keeps a typed rate as manual', async () => {
    serveDialog()
    const sent = capturePut()
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={villa} />)
    const dialog = await screen.findByRole('dialog')
    const rate = await within(dialog).findByLabelText(/Exchange rate/)
    expect(rate).toHaveValue('0.92')
    expect(within(dialog).getByText(/entered manually on 10\/18\/2026/)).toBeInTheDocument()
    await user.clear(rate)
    await user.type(rate, '0,95')
    expect(within(dialog).getByText(/EUR per 1 USD · entered manually$/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ currency: 'EUR', exchangeRate: '0.95' })
    expect(sent[0]).not.toHaveProperty('exchangeRateSource')
  })

  it('edit: "Fetch current rate" fills the online rate, saved as online', async () => {
    const requests = serveDialog()
    const sent = capturePut()
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={villa} />)
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: 'Fetch current rate' }))
    await waitFor(() => expect(within(dialog).getByLabelText(/Exchange rate/)).toHaveValue('0.9237'))
    expect(requests).toEqual(['EUR'])
    expect(within(dialog).getByText(/online rate of 10\/18\/2026/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ exchangeRate: '', exchangeRateSource: 'online' })
  })

  it('edit: a new currency always clears the rate and fetches its own; typed rates come back with their currency', async () => {
    const requests = serveDialog()
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={villa} />)
    const dialog = await screen.findByRole('dialog')
    const currency = await within(dialog).findByRole('combobox', { name: /Currency/ })
    await waitFor(() => expect(currency).toHaveValue('EUR – Euro'))
    const rate = () => within(dialog).getByLabelText(/Exchange rate/)
    // A rate typed for EUR does not survive the switch to PKR.
    await user.clear(rate())
    await user.type(rate(), '0,95')
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'PKR – Pakistani Rupee' }))
    await waitFor(() => expect(rate()).toHaveValue('278.5'))

    // The provider has no CHF: said so, nothing fetched.
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'CHF – Swiss Franc' }))
    expect(within(dialog).getByText('No online rate for CHF – enter it by hand.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Fetch current rate' })).toBeDisabled()
    expect(rate()).toHaveValue('')

    // Typed for CHF, then JPY (provider down): cleared, the failure shown.
    await user.type(rate(), '1,1')
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'JPY – Japanese Yen' }))
    expect(await within(dialog).findByText(/exchange rate service cannot be reached/)).toBeInTheDocument()
    expect(rate()).toHaveValue('')

    // Back to CHF and EUR: the rates typed for them return.
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'CHF – Swiss Franc' }))
    expect(rate()).toHaveValue('1,1')
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'EUR – Euro' }))
    expect(rate()).toHaveValue('0,95')
    expect(requests).toEqual(['PKR', 'JPY'])
  })

  it('edit: a fetch failure of a currency no longer chosen is not shown', async () => {
    let release = () => {}
    serveDialog()
    server.use(
      http.get('/api/exchange-rates/:currency', async ({ params }) => {
        if (params.currency === 'JPY') {
          await new Promise<void>((resolve) => (release = resolve))
          return problem(503, { code: 'exchange_rate.unavailable' })
        }
        return HttpResponse.json({ currency: params.currency, rate: '278.5', date: '2026-10-18T00:00:00Z', provider: 'open.er-api.com' })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={villa} />)
    const dialog = await screen.findByRole('dialog')
    const currency = await within(dialog).findByRole('combobox', { name: /Currency/ })
    await waitFor(() => expect(currency).toHaveValue('EUR – Euro'))
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'JPY – Japanese Yen' }))
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'PKR – Pakistani Rupee' }))
    await waitFor(() => expect(within(dialog).getByLabelText(/Exchange rate/)).toHaveValue('278.5'))
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(within(dialog).queryByText(/exchange rate service cannot be reached/)).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Exchange rate/)).toHaveValue('278.5')
  })

  it('edit: a rate far off the online rate is saved only when saved again', async () => {
    serveDialog()
    const sent: Record<string, unknown>[] = []
    server.use(
      http.put('/api/projects/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        sent.push(body)
        if (!body.exchangeRateConfirmed) {
          return problem(422, {
            code: 'validation.failed',
            fields: [{ location: 'body.exchangeRate', code: 'project.exchange_rate_implausible', params: { currency: 'PKR', online: '278.5' } }],
          })
        }
        return HttpResponse.json(villa)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProjectFormDialog open onOpenChange={() => {}} item={villa} />)
    const dialog = await screen.findByRole('dialog')
    const currency = await within(dialog).findByRole('combobox', { name: /Currency/ })
    await waitFor(() => expect(currency).toHaveValue('EUR – Euro'))
    await user.click(currency)
    await user.click(await screen.findByRole('option', { name: 'PKR – Pakistani Rupee' }))
    const rate = within(dialog).getByLabelText(/Exchange rate/)
    await waitFor(() => expect(rate).toHaveValue('278.5'))
    await user.clear(rate)
    await user.type(rate, '2,785')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await within(dialog).findByText(/far off today's online rate of PKR \(1 USD = 278.5 PKR\)/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[0]).not.toHaveProperty('exchangeRateConfirmed')
    expect(sent[1]).toMatchObject({ currency: 'PKR', exchangeRate: '2.785', exchangeRateConfirmed: true })
  })
})

function serveRate() {
  const calls: string[] = []
  server.use(
    http.post('/api/projects/:id/exchange-rate/refresh', async ({ request }) => {
      calls.push(`refresh ${((await request.json()) as { currency: string }).currency}`)
      return HttpResponse.json(online)
    }),
    http.put('/api/projects/:id/exchange-rate', async ({ request }) => {
      const body = (await request.json()) as { rate: string; currency: string }
      calls.push(`set ${body.rate} ${body.currency}`)
      return HttpResponse.json({ ...villa, exchangeRate: '0.95' })
    }),
  )
  return calls
}

describe('RateBar', () => {
  it('without a rate: says so; Update rate fetches it', async () => {
    const calls = serveRate()
    const user = userEvent.setup()
    renderWithProviders(<RateBar project={noRate} versionId={villa.versions[0].id} />)
    expect(screen.getByText('No exchange rate yet – fetch or set one')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Update rate' }))
    await waitFor(() => expect(calls).toEqual(['refresh EUR']))
  })

  it('online: rate, date, no warning while fresh; a warning when stale', () => {
    const { unmount } = renderWithProviders(<RateBar project={online} versionId={villa.versions[0].id} />)
    expect(screen.getByText('1 USD = 0.9237 EUR')).toBeInTheDocument()
    expect(screen.getByText(/online, 10\/18\/2026/)).toBeInTheDocument()
    expect(screen.queryByText(/days old/)).not.toBeInTheDocument()
    unmount()
    renderWithProviders(<RateBar project={{ ...online, exchangeRateStale: true, exchangeRateAgeDays: 12 }} versionId={villa.versions[0].id} />)
    expect(screen.getByText(/Rate is 12 days old \(older than 7 days\)/)).toBeInTheDocument()
  })

  it('manual: entered manually, never a warning; Set rate sends the typed rate', async () => {
    const calls = serveRate()
    const user = userEvent.setup()
    renderWithProviders(<RateBar project={{ ...villa, exchangeRateStale: true, exchangeRateAgeDays: 40 }} versionId={villa.versions[0].id} />)
    expect(screen.getByText(/entered manually on 10\/18\/2026/)).toBeInTheDocument()
    expect(screen.queryByText(/days old/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Set rate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set exchange rate' })
    const rate = within(dialog).getByLabelText(/Exchange rate/)
    await user.clear(rate)
    await user.type(rate, '0,95')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(calls).toEqual(['set 0.95 EUR']))
  })

  it('read-only projects and USD projects', () => {
    const { unmount } = renderWithProviders(<RateBar project={{ ...villa, can: { update: false, delete: false, reopen: true } }} versionId={villa.versions[0].id} />)
    expect(screen.getByText('1 USD = 0.92 EUR')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    unmount()
    renderWithProviders(<RateBar project={{ ...villa, currency: 'USD', exchangeRate: '1' }} versionId={villa.versions[0].id} />)
    expect(screen.queryByTestId('rate-bar')).not.toBeInTheDocument()
  })

  it('a new rate reloads the BOM and the pricing preview', async () => {
    serveRate()
    const loads: string[] = []
    server.use(
      http.get('/api/versions/:versionId/pricing', () => {
        loads.push('pricing')
        return HttpResponse.json(bom.pricing)
      }),
      http.post('/api/versions/:versionId/pricing/preview', () => {
        loads.push('preview')
        return HttpResponse.json(bom.totals)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <RateBar project={villa} versionId={versionId} />
        <PricingTab versionId={versionId} canWrite />
      </>,
    )
    await waitFor(() => expect(loads).toContain('preview'))
    const before = loads.length
    await user.click(screen.getByRole('button', { name: 'Update rate' }))
    await waitFor(() => expect(loads.slice(before)).toEqual(expect.arrayContaining(['pricing', 'preview'])))
  })
})
