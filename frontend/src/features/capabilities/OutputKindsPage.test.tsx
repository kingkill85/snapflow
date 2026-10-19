import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { FunctionType, OutputKind, OutputKindInput, OutputKindUpdate } from '@/api/generated/model'
import { adminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { chooseOption } from '@/test/select'
import { server } from '@/test/server'
import { translation } from '@/test/translatable'

import { OutputKindsPage } from './OutputKindsPage'
import { outputKind, problem, readOnly } from './test-fixtures'

const functionType = (id: string, key: string, name: string): FunctionType => ({
  id,
  key,
  name: { en: name },
  allowsCircuit: false,
  loadTypeIds: [],
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})
const switching = functionType('00000000-0000-4000-8000-0000000000f1', 'switching', 'Switching')
const blinds = functionType('00000000-0000-4000-8000-0000000000f2', 'blind', 'Blind')

const relay = outputKind({ functionTypeIds: [switching.id] })
const blind = outputKind({
  id: '00000000-0000-4000-8000-0000000000b2',
  key: 'blind_output',
  name: { en: 'Blind output' },
  sortOrder: 2,
  functionTypeIds: [blinds.id],
  alternatives: [{ outputKindId: relay.id, count: 2 }],
})

function handlers(all: () => OutputKind[]) {
  return [
    http.get('/api/output-kinds', ({ request }) => {
      const inactive = new URL(request.url).searchParams.get('includeInactive') === 'true'
      return HttpResponse.json({ items: inactive ? all() : all().filter((k) => k.isActive) })
    }),
    http.get('/api/function-types', () => HttpResponse.json({ items: [switching, blinds] })),
  ]
}

describe('OutputKindsPage', () => {
  it('lists output kinds with the functions they serve and their alternative', async () => {
    server.use(...handlers(() => [relay, blind]))
    renderWithProviders(<OutputKindsPage />, { me: adminMe })
    const row = (await screen.findByText('Blind output')).closest('tr')!
    expect(within(row).getByText('Blind')).toBeInTheDocument()
    expect(await within(row).findByText('2 × Relay output')).toBeInTheDocument()
  })

  it('is read-only without catalog.write', async () => {
    server.use(...handlers(() => [{ ...relay, can: readOnly }]))
    renderWithProviders(<OutputKindsPage />, { me: userMe })
    expect(await screen.findByText('Relay output')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('creates an output kind with served function types and an alternative', async () => {
    let posted: OutputKindInput | undefined
    server.use(
      ...handlers(() => [relay]),
      http.post('/api/output-kinds', async ({ request }) => {
        posted = (await request.json()) as OutputKindInput
        return HttpResponse.json(blind, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<OutputKindsPage />, { me: adminMe })
    await u.click(await screen.findByRole('button', { name: 'New output kind' }))
    const dialog = await screen.findByRole('dialog', { name: 'New output kind' })
    await u.type(within(dialog).getByLabelText('Key'), 'blind_output')
    await u.type(await translation(u, dialog, 'Name', 'en'), 'Blind output')
    await u.click(await within(dialog).findByRole('checkbox', { name: 'Blind' }))
    await u.click(within(dialog).getByRole('button', { name: 'Add alternative' }))
    await chooseOption(u, within(dialog).getByRole('combobox', { name: 'Kind' }), 'Relay output')
    // A second row with the same kind is refused before saving, and can be removed.
    await u.click(within(dialog).getByRole('button', { name: 'Add alternative' }))
    await chooseOption(u, within(within(dialog).getByRole('group', { name: 'Alternative 2' })).getByRole('combobox', { name: 'Kind' }), 'Relay output')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('This output kind is listed twice as an alternative.')).toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Remove Alternative 2' }))
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({
      key: 'blind_output',
      name: { en: 'Blind output' },
      functionTypeIds: [blinds.id],
      alternatives: [{ outputKindId: relay.id, count: 2 }],
      isActive: true,
    })
  })

  it('updates with expectedUpdatedAt and shows an alternative cycle at the field', async () => {
    let sent: OutputKindUpdate | undefined
    server.use(
      ...handlers(() => [relay, blind]),
      http.put('/api/output-kinds/:id', async ({ request }) => {
        sent = (await request.json()) as OutputKindUpdate
        return problem(422, {
          code: 'validation.failed',
          fields: [{ location: 'body.alternatives[0].outputKindId', code: 'output_kind.alternative_cycle' }],
        })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<OutputKindsPage />, { me: adminMe })
    const row = (await screen.findByText('Blind output')).closest('tr')!
    await u.click(within(row).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit output kind' })
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(sent?.expectedUpdatedAt).toBe(blind.updatedAt))
    expect(sent?.alternatives).toEqual([{ outputKindId: relay.id, count: 2 }])
    expect(await within(dialog).findAllByText('That output kind already has this one as an alternative.')).not.toHaveLength(0)
  })
})
