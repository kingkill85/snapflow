import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { CatalogField, CatalogFieldInput, CatalogFieldUpdate } from '@/api/generated/model'
import { adminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { chooseOption } from '@/test/select'
import { server } from '@/test/server'
import { translation } from '@/test/translatable'

import { CatalogFieldsPage } from './CatalogFieldsPage'
import { catalogField, loadType, meanings, outputKind, problem, readOnly } from './test-fixtures'

const dimmer = outputKind({ id: '00000000-0000-4000-8000-0000000000b3', key: 'dimmer_output', name: { en: 'Dimmer output' } })
const led = loadType({})
const width = catalogField({})
const ledLimit = catalogField({
  id: '00000000-0000-4000-8000-0000000000c2',
  key: 'dimmer_led_w',
  label: { en: 'Max LED per output' },
  unit: 'W',
  meaning: 'channel_limit_w',
  outputKindId: dimmer.id,
  loadTypeId: led.id,
  sortOrder: 2,
})
const notes = catalogField({ id: '00000000-0000-4000-8000-0000000000c3', key: 'notes', label: { en: 'Notes' }, type: 'text', unit: undefined, meaning: undefined })

function handlers(all: () => CatalogField[]) {
  return [
    http.get('/api/catalog-fields', () => HttpResponse.json({ items: all() })),
    http.get('/api/catalog-field-meanings', () => HttpResponse.json({ items: meanings })),
    http.get('/api/output-kinds', () => HttpResponse.json({ items: [dimmer] })),
    http.get('/api/load-types', () => HttpResponse.json({ items: [led] })),
    http.get('/api/product-types', () => HttpResponse.json({ items: [] })),
  ]
}

describe('CatalogFieldsPage', () => {
  it('lists fields with their type, unit and meaning in words', async () => {
    server.use(...handlers(() => [width, ledLimit, notes]))
    renderWithProviders(<CatalogFieldsPage />, { me: adminMe })
    const row = (await screen.findByText('Max LED per output')).closest('tr')!
    expect(await within(row).findByText('Max. load per channel (W) · Dimmer output · LED')).toBeInTheDocument()
    expect(within(row).getByText('Number (W)')).toBeInTheDocument()
    expect(within(screen.getByText('Notes').closest('tr')!).getByText('Just information')).toBeInTheDocument()
  })

  it('is read-only without catalog.write', async () => {
    server.use(...handlers(() => [{ ...width, can: readOnly }]))
    renderWithProviders(<CatalogFieldsPage />, { me: userMe })
    expect(await screen.findByText('Width')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('creates a field whose meaning asks for an output kind and a load type', async () => {
    let posted: CatalogFieldInput | undefined
    server.use(
      ...handlers(() => [width]),
      http.post('/api/catalog-fields', async ({ request }) => {
        posted = (await request.json()) as CatalogFieldInput
        return HttpResponse.json(ledLimit, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<CatalogFieldsPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'New field' }))
    const dialog = await screen.findByRole('dialog', { name: 'New field' })
    await u.type(within(dialog).getByLabelText('Key'), 'dimmer_led_w')
    await u.type(await translation(u, dialog, 'Label', 'en'), 'Max LED per output')
    await u.type(within(dialog).getByLabelText('Unit'), 'W')
    // No parameters until a meaning needs them.
    expect(within(dialog).queryByRole('combobox', { name: 'Output kind' })).not.toBeInTheDocument()
    await chooseOption(u, within(dialog).getByRole('combobox', { name: 'Meaning' }), 'Max. load per channel (W)')
    await chooseOption(u, within(dialog).getByRole('combobox', { name: 'Output kind' }), 'Dimmer output')
    await chooseOption(u, within(dialog).getByRole('combobox', { name: 'Load type' }), 'LED')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({
      key: 'dimmer_led_w',
      label: { en: 'Max LED per output' },
      type: 'number',
      unit: 'W',
      meaning: 'channel_limit_w',
      outputKindId: dimmer.id,
      loadTypeId: led.id,
      productTypeIds: [],
    })
  })

  it('edits an enum field: choices, expectedUpdatedAt, server errors at the field', async () => {
    const motor = catalogField({
      id: '00000000-0000-4000-8000-0000000000c4',
      key: 'motor',
      label: { en: 'Motor' },
      type: 'enum',
      unit: undefined,
      meaning: 'motor_type',
      options: [{ key: 'ac', label: { en: 'AC' } }],
    })
    let sent: CatalogFieldUpdate | undefined
    server.use(
      ...handlers(() => [motor]),
      http.put('/api/catalog-fields/:id', async ({ request }) => {
        sent = (await request.json()) as CatalogFieldUpdate
        return problem(422, { code: 'validation.failed', fields: [{ location: 'body.meaning', code: 'catalog_field.meaning_type', params: { expected: 'enum' } }] })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<CatalogFieldsPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit field' })
    await u.click(within(dialog).getByRole('button', { name: 'Add choice' }))
    const keys = within(dialog).getAllByLabelText('Key')
    await u.type(keys[keys.length - 1], 'dc')
    const labels = within(dialog).getAllByRole('tablist', { name: 'Translations of Label' })
    const choice = labels[labels.length - 1].closest<HTMLElement>('[data-translatable]')!
    await u.type(within(choice).getByLabelText('Label'), 'DC')
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent).toBeDefined())
    expect(sent).toMatchObject({
      key: 'motor',
      type: 'enum',
      meaning: 'motor_type',
      options: [
        { key: 'ac', label: { en: 'AC' } },
        { key: 'dc', label: { en: 'DC' } },
      ],
      expectedUpdatedAt: motor.updatedAt,
    })
    expect(within(dialog).getByRole('combobox', { name: 'Meaning' })).toHaveAccessibleDescription('This meaning needs another value type (enum).')
  })

  it('shows why a linked field cannot be deleted', async () => {
    server.use(
      ...handlers(() => [width]),
      http.delete('/api/catalog-fields/:id', () => problem(409, { code: 'catalog_field.in_use', params: { key: 'width_te' } })),
    )
    const u = userEvent.setup()
    renderWithProviders(<CatalogFieldsPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete field' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByText(/Categories link the field "width_te"/)).toBeInTheDocument()
  })
})
