import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { LoadType, LoadTypeInput, LoadTypeUpdate } from '@/api/generated/model'
import { adminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'
import { translation } from '@/test/translatable'

import { LoadTypesPage } from './LoadTypesPage'
import { loadType, problem, readOnly } from './test-fixtures'

const led = loadType({ powerFactor: 0.9 })
const halogen = loadType({ id: '00000000-0000-4000-8000-0000000000a2', key: 'halogen', name: { en: 'Halogen' }, sortOrder: 2, isActive: false })

function listHandler(all: () => LoadType[]) {
  return http.get('/api/load-types', ({ request }) => {
    const inactive = new URL(request.url).searchParams.get('includeInactive') === 'true'
    return HttpResponse.json({ items: inactive ? all() : all().filter((l) => l.isActive) })
  })
}

describe('LoadTypesPage', () => {
  it('lists active load types and shows inactive ones on request', async () => {
    server.use(listHandler(() => [led, halogen]))
    const u = userEvent.setup()
    renderWithProviders(<LoadTypesPage />, { me: adminMe })
    expect(await screen.findByText('LED')).toBeInTheDocument()
    expect(screen.queryByText('Halogen')).not.toBeInTheDocument()
    await u.click(screen.getByLabelText('Show inactive'))
    expect(await screen.findByText('Halogen')).toBeInTheDocument()
  })

  it('is read-only without catalog.write', async () => {
    server.use(listHandler(() => [{ ...led, can: readOnly }]))
    renderWithProviders(<LoadTypesPage />, { me: userMe })
    expect(await screen.findByText('LED')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('creates a load type', async () => {
    let all = [led]
    let posted: LoadTypeInput | undefined
    server.use(
      listHandler(() => all),
      http.post('/api/load-types', async ({ request }) => {
        posted = (await request.json()) as LoadTypeInput
        const created = loadType({ id: '00000000-0000-4000-8000-0000000000a3', key: 'motor', name: { en: 'Motor' }, sortOrder: 2 })
        all = [...all, created]
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<LoadTypesPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'New load type' }))
    const dialog = await screen.findByRole('dialog', { name: 'New load type' })
    await u.type(within(dialog).getByLabelText('Key'), 'motor')
    await u.type(await translation(u, dialog, 'Name', 'en'), 'Motor')
    const pf = within(dialog).getByLabelText(/Power factor/)
    expect(pf).toHaveValue('1.00')
    await u.clear(pf)
    await u.type(pf, '1.5')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText(/between 0.1 and 1/i)).toBeInTheDocument()
    await u.clear(pf)
    await u.type(pf, '0,7')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ key: 'motor', name: { en: 'Motor' }, powerFactor: 0.7, isActive: true })
    expect(await screen.findByText('Motor')).toBeInTheDocument()
  })

  it('updates with the version it was opened with', async () => {
    let sent: LoadTypeUpdate | undefined
    server.use(
      listHandler(() => [led]),
      http.put('/api/load-types/:id', async ({ request }) => {
        sent = (await request.json()) as LoadTypeUpdate
        return HttpResponse.json({ ...led, name: { en: 'LED lamps' } })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<LoadTypesPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit load type' })
    const name = await translation(u, dialog, 'Name', 'en')
    await u.clear(name)
    await u.type(name, 'LED lamps')
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toEqual({ key: 'led', name: { en: 'LED lamps' }, powerFactor: 0.9, isActive: true, expectedUpdatedAt: led.updatedAt }))
  })

  it('shows why a load type in use cannot be deleted', async () => {
    server.use(
      listHandler(() => [led]),
      http.delete('/api/load-types/:id', () => problem(409, { code: 'load_type.in_use' })),
    )
    const u = userEvent.setup()
    renderWithProviders(<LoadTypesPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete load type' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByText('This load type is still used by functions, catalog fields, needs or room templates.')).toBeInTheDocument()
  })

  it('moves a load type down, sending all ids', async () => {
    const motor = loadType({ id: '00000000-0000-4000-8000-0000000000a3', key: 'motor', name: { en: 'Motor' }, sortOrder: 2 })
    let ids: string[] | undefined
    server.use(
      listHandler(() => [led, motor]),
      http.put('/api/load-types/order', async ({ request }) => {
        ids = ((await request.json()) as { ids: string[] }).ids
        return HttpResponse.json({ items: [motor, led] })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<LoadTypesPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'Move LED down' }))
    await waitFor(() => expect(ids).toEqual([motor.id, led.id]))
  })
})
