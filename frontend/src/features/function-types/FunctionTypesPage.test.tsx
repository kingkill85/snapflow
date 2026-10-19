import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { FunctionType } from '@/api/generated/model'
import { userMe } from '@/test/fixtures'
import { translation } from '@/test/translatable'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { FunctionTypesPage } from './FunctionTypesPage'

const dimmer: FunctionType = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'dimmer',
  name: { en: 'Dimmer', de: 'Dimmer' },
  allowsCircuit: false,
  loadTypeIds: [],
  isActive: true,
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
}

const led = {
  id: '6f1c2b8e-0000-4000-8000-0000000000aa',
  key: 'led',
  name: { en: 'LED' },
  isActive: true,
  sortOrder: 1,
  can: { update: true, delete: true },
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
}
const loadTypes = () => http.get('/api/load-types', () => HttpResponse.json({ items: [led] }))

describe('FunctionTypesPage', () => {
  it('lists function types', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer] })))
    renderWithProviders(<FunctionTypesPage />)

    expect(await screen.findByText('dimmer')).toBeInTheDocument()
    expect(screen.getByText('Dimmer')).toBeInTheDocument()
  })

  it('is read-only without catalog.write', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer] })))
    renderWithProviders(<FunctionTypesPage />, { me: userMe })

    expect(await screen.findByText('dimmer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new function type/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
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
      loadTypes(),
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
    await user.type((await translation(user, dialog, 'Name', 'en')), 'Dimmer')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'LED' }))
    await user.click(within(dialog).getByRole('switch', { name: /share one channel/i }))
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ key: 'dimmer', name: { en: 'Dimmer' }, allowsCircuit: true, loadTypeIds: [led.id], isActive: true })
    expect(await screen.findByText('dimmer')).toBeInTheDocument()
  })

  it('sends the stored circuit flag and load types when updating other fields', async () => {
    const stored = { ...dimmer, allowsCircuit: true, loadTypeIds: [led.id] }
    let sent: unknown
    server.use(
      loadTypes(),
      http.get('/api/function-types', () => HttpResponse.json({ items: [stored] })),
      http.put('/api/function-types/:id', async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(stored)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('checkbox', { name: 'LED' })).toBeChecked()
    expect(within(dialog).getByRole('switch', { name: /share one channel/i })).toBeChecked()
    const key = within(dialog).getByLabelText('Key')
    await user.clear(key)
    await user.type(key, 'dimming')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(sent).toEqual({ key: 'dimming', name: { en: 'Dimmer', de: 'Dimmer' }, allowsCircuit: true, loadTypeIds: [led.id], isActive: true }))
  })

  it('shows the status and deactivates with the Active switch (the last field)', async () => {
    let sent: unknown
    server.use(
      loadTypes(),
      http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer, { ...dimmer, id: 'x2', key: 'blind', name: { en: 'Blind' }, isActive: false }] })),
      http.put('/api/function-types/:id', async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(dimmer)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    expect(await screen.findByText('Inactive')).toBeInTheDocument()
    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    const switches = within(dialog).getAllByRole('switch')
    const active = within(dialog).getByRole('switch', { name: /^active/i })
    expect(switches[switches.length - 1]).toBe(active)
    expect(active).toBeChecked()
    await user.click(active)
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(sent).toMatchObject({ key: 'dimmer', isActive: false }))
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
    await user.type((await translation(user, dialog, 'Name', 'en')), 'Dimmer')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The key "dimmer" is already used.')
  })

  it('shows a server error of one language on the tab of that language', async () => {
    server.use(
      http.get('/api/function-types', () => HttpResponse.json({ items: [] })),
      http.post('/api/function-types', () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'validation.failed',
            fields: [{ location: 'body.name.de', code: 'validation.control_chars' }],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new function type/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'dimmer')
    await user.type(await translation(user, dialog, 'Name', 'en'), 'Dimmer')
    await user.type(await translation(user, dialog, 'Name', 'de'), 'Dimmer')
    await user.click(within(dialog).getByRole('tab', { name: 'English' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    // The German tab opens, is marked, and its input shows the error.
    const german = within(dialog).getByRole('tab', { name: 'German' })
    await waitFor(() => expect(german).toHaveAttribute('aria-selected', 'true'))
    expect(german).toHaveAccessibleDescription('Has an error')
    expect(within(dialog).getByRole('tab', { name: 'English' })).toHaveAccessibleDescription('Filled in')
    const input = within(dialog).getByLabelText('Name')
    expect(input).toHaveAttribute('lang', 'de')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(/control characters/i)
  })
})
