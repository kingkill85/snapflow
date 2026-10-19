import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { FunctionType, RoomTemplate } from '@/api/generated/model'
import { loadType } from '@/features/capabilities/test-fixtures'
import { userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { chooseOption, optionTexts } from '@/test/select'
import { server } from '@/test/server'
import { translation } from '@/test/translatable'

import { RoomTemplatesPage } from './RoomTemplatesPage'

const led = loadType({ id: '00000000-0000-4000-8000-0000000000a1', key: 'led', name: { en: 'LED' } })
const halogen = loadType({ id: '00000000-0000-4000-8000-0000000000a2', key: 'halogen', name: { en: 'Halogen' }, sortOrder: 2 })
const motor = loadType({ id: '00000000-0000-4000-8000-0000000000a3', key: 'motor', name: { en: 'Motor' }, sortOrder: 3 })

const functionType = (over: Partial<FunctionType>): FunctionType => ({
  id: '00000000-0000-4000-8000-0000000000f1',
  key: 'dimmer',
  name: { en: 'Dimmable light' },
  allowsCircuit: true,
  knxObjects: [],
  loadTypeIds: [],
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})
const dimmer = functionType({ loadTypeIds: [led.id, halogen.id] })
const blind = functionType({ id: '00000000-0000-4000-8000-0000000000f2', key: 'blind', name: { en: 'Blind' }, loadTypeIds: [motor.id] })
const oldType = functionType({ id: '00000000-0000-4000-8000-0000000000f3', key: 'old', name: { en: 'Old switching' }, isActive: false })

const template = (over: Partial<RoomTemplate>): RoomTemplate => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  key: 'living_comfort',
  name: { en: 'Living room' },
  equipmentLevel: { en: 'Comfort' },
  sortOrder: 1,
  isActive: true,
  lines: [{ functionTypeId: dimmer.id, quantity: 3, powerW: '7.50', loadTypeId: led.id, label: 'Ceiling', warnings: [] }],
  can: { update: true, delete: true },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

const catalog = () => [
  http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer, blind, oldType] })),
  http.get('/api/load-types', () => HttpResponse.json({ items: [led, halogen, motor] })),
]

describe('RoomTemplatesPage', () => {
  it('lists templates with level, line count and status', async () => {
    server.use(http.get('/api/room-templates', () => HttpResponse.json({ items: [template({}), template({ id: 'x2', name: { en: 'Bath' }, equipmentLevel: {}, lines: [], isActive: false })] })))
    renderWithProviders(<RoomTemplatesPage />)

    expect(await screen.findByText('Living room')).toBeInTheDocument()
    expect(screen.getByText('Comfort')).toBeInTheDocument()
    expect(screen.getByText('1 line')).toBeInTheDocument()
    expect(screen.getByText('0 lines')).toBeInTheDocument()
    expect(screen.getByText('Inactive')).toBeInTheDocument()
  })

  it('is read-only without catalog.write', async () => {
    server.use(http.get('/api/room-templates', () => HttpResponse.json({ items: [template({ can: { update: false, delete: false } })] })))
    renderWithProviders(<RoomTemplatesPage />, { me: userMe })

    expect(await screen.findByText('Living room')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new room template/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
  })

  it('creates a template with a line; load types follow the function type', async () => {
    let items: RoomTemplate[] = []
    let posted: unknown
    server.use(
      ...catalog(),
      http.get('/api/room-templates', () => HttpResponse.json({ items })),
      http.post('/api/room-templates', async ({ request }) => {
        posted = await request.json()
        items = [template({})]
        return HttpResponse.json(items[0], { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<RoomTemplatesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new room template/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'living_comfort')
    await user.type(await translation(user, dialog, 'Name', 'en'), 'Living room')
    await user.type(await translation(user, dialog, 'Equipment level', 'en'), 'Comfort')
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }))
    const line = within(dialog).getByRole('group', { name: 'Line 1' })

    // Inactive function types are not offered for a new line.
    expect(await optionTexts(user, within(line).getByRole('combobox', { name: /function type/i }))).toEqual(['Dimmable light', 'Blind'])
    await chooseOption(user, within(line).getByRole('combobox', { name: /function type/i }), 'Dimmable light')
    expect(await optionTexts(user, within(line).getByRole('combobox', { name: 'Load type' }))).toEqual(['None', 'LED', 'Halogen'])
    await chooseOption(user, within(line).getByRole('combobox', { name: 'Load type' }), 'LED')
    const quantity = within(line).getByLabelText(/quantity/i)
    await user.clear(quantity)
    await user.type(quantity, '3')
    await user.type(within(line).getByLabelText(/power per unit/i), '7,5')
    await user.type(within(line).getByLabelText(/^label/i), 'Ceiling')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({
      key: 'living_comfort',
      name: { en: 'Living room' },
      equipmentLevel: { en: 'Comfort' },
      lines: [{ functionTypeId: dimmer.id, quantity: 3, powerW: '7.50', loadTypeId: led.id, label: 'Ceiling' }],
      isActive: true,
    })
    expect(await screen.findByText('Living room')).toBeInTheDocument()
  })

  it('clears a load type the new function type does not allow', async () => {
    server.use(...catalog(), http.get('/api/room-templates', () => HttpResponse.json({ items: [template({})] })))
    const user = userEvent.setup()
    renderWithProviders(<RoomTemplatesPage />)

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    const line = within(dialog).getByRole('group', { name: 'Line 1' })
    expect(within(line).getByLabelText(/power per unit/i)).toHaveValue('7.5')
    await waitFor(() => expect(within(line).getByRole('combobox', { name: 'Load type' })).toHaveTextContent('LED'))
    await chooseOption(user, within(line).getByRole('combobox', { name: /function type/i }), 'Blind')
    expect(within(line).getByRole('combobox', { name: 'Load type' })).toHaveTextContent('None')
  })

  it('keeps a stored line with an inactive function type, flagged as skipped, and sends expectedUpdatedAt', async () => {
    let sent: unknown
    const stored = template({ lines: [{ functionTypeId: oldType.id, quantity: 2, powerW: null, loadTypeId: null, label: '', warnings: ['function_type_inactive'] }] })
    server.use(
      ...catalog(),
      http.get('/api/room-templates', () => HttpResponse.json({ items: [stored] })),
      http.put('/api/room-templates/:id', async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(stored)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<RoomTemplatesPage />)

    // The list says which lines the editor skips.
    expect(await screen.findByText('1 line skipped')).toBeInTheDocument()
    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Inactive function type: this line is skipped when the template is applied.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Choose an active one/)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: /function type/i })).toHaveTextContent('Old switching (inactive)')

    // A new line with the same inactive function type would be kept too; one with another would not be offered.
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toMatchObject({ expectedUpdatedAt: stored.updatedAt, lines: [{ functionTypeId: oldType.id, quantity: 2, powerW: null, loadTypeId: null }] }))
  })

  it('validates quantity and power before sending', async () => {
    server.use(...catalog(), http.get('/api/room-templates', () => HttpResponse.json({ items: [] })))
    const user = userEvent.setup()
    renderWithProviders(<RoomTemplatesPage />)

    await user.click((await screen.findAllByRole('button', { name: /new room template/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }))
    const line = within(dialog).getByRole('group', { name: 'Line 1' })
    const quantity = within(line).getByLabelText(/quantity/i)
    await user.clear(quantity)
    await user.type(quantity, '0')
    // A third decimal is refused like the backend refuses it.
    await user.type(within(line).getByLabelText(/power per unit/i), '7.555')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(line).findByText(/between 1 and 100/i)).toBeInTheDocument()
    expect(within(line).getByText('Enter a power of 0 to 100,000 W with at most 2 decimals.')).toBeInTheDocument()
  })

  it('moves a template down', async () => {
    let order: unknown
    const a = template({})
    const b = template({ id: '00000000-0000-4000-8000-0000000000e2', key: 'bath', name: { en: 'Bath' }, sortOrder: 2 })
    server.use(
      http.get('/api/room-templates', () => HttpResponse.json({ items: [a, b] })),
      http.put('/api/room-templates/order', async ({ request }) => {
        order = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<RoomTemplatesPage />)

    await user.click(await screen.findByRole('button', { name: 'Move Living room down' }))
    await waitFor(() => expect(order).toEqual({ ids: [b.id, a.id] }))
  })
})
