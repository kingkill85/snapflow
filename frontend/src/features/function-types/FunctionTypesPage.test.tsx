import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { FunctionType } from '@/api/generated/model'
import { server } from '@/test/server'
import { renderWithProviders } from '@/test/render'

import { FunctionTypesPage } from './FunctionTypesPage'

const dimmer: FunctionType = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'dimmer',
  name: { en: 'Dimmer', de: 'Dimmer' },
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
}

describe('FunctionTypesPage', () => {
  it('lists function types', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer] })))
    renderWithProviders(<FunctionTypesPage />)

    expect(await screen.findByText('dimmer')).toBeInTheDocument()
    expect(screen.getByText('Dimmer')).toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [] })))
    renderWithProviders(<FunctionTypesPage />)

    expect(await screen.findByText('No function types yet.')).toBeInTheDocument()
  })

  it('creates a function type and refreshes the list', async () => {
    let items: FunctionType[] = []
    let posted: unknown
    server.use(
      http.get('/api/function-types', () => HttpResponse.json({ items })),
      http.post('/api/function-types', async ({ request }) => {
        posted = await request.json()
        items = [dimmer]
        return HttpResponse.json(dimmer, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new function type/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'dimmer')
    await user.type(within(dialog).getByLabelText('Name (English)'), 'Dimmer')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ key: 'dimmer', name: { en: 'Dimmer' } })
    expect(await screen.findByText('dimmer')).toBeInTheDocument()
  })

  it('validates the key before sending', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [] })))
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new function type/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'Not Valid')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByText(/lower case letters/i)).toBeInTheDocument()
  })

  it('translates API error codes', async () => {
    server.use(
      http.get('/api/function-types', () => HttpResponse.json({ items: [] })),
      http.post('/api/function-types', () =>
        HttpResponse.json(
          { status: 409, code: 'function_type.key_taken', params: { key: 'dimmer' } },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new function type/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'dimmer')
    await user.type(within(dialog).getByLabelText('Name (English)'), 'Dimmer')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The key "dimmer" is already used.')
  })
})
