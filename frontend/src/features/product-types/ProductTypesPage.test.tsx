import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { ProductType } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProductTypesPage } from './ProductTypesPage'

const sample: ProductType = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'sample',
  name: { en: 'Sample', de: 'Beispiel' },
  sortOrder: 1,
  isActive: true,
  attributes: [],
  instanceAttributes: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
}

describe('ProductTypesPage', () => {
  it('lists items', async () => {
    server.use(http.get('/api/product-types', () => HttpResponse.json({ items: [sample] })))
    renderWithProviders(<ProductTypesPage />)

    expect(await screen.findByText('Sample')).toBeInTheDocument()
  })

  it('creates an item', async () => {
    let items: ProductType[] = []
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items })),
      http.post('/api/product-types', () => {
        items = [sample]
        return HttpResponse.json(sample, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProductTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'sample')
    await user.type(within(dialog).getByLabelText('Name (English)'), 'Sample')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Sample')).toBeInTheDocument()
  })
})
