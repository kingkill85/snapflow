import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import type { FunctionType, OutputKind, ProductType } from '@/api/generated/model'
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
  knxObjects: [],
  loadTypeIds: [],
  outputKindIds: [],
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

const kind = (id: string, key: string, en: string, sortOrder: number, isActive = true): OutputKind => ({
  id,
  key,
  name: { en },
  sortOrder,
  isActive,
  functionTypeIds: [],
  alternatives: [],
  can: { update: true, delete: true },
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
})
const dimmerOutput = kind('6f1c2b8e-0000-4000-8000-0000000000d1', 'dimmer_output', 'Dimmer output', 1)
const relayOutput = kind('6f1c2b8e-0000-4000-8000-0000000000d2', 'relay_output', 'Relay output', 2)
const oldOutput = kind('6f1c2b8e-0000-4000-8000-0000000000d3', 'old_output', 'Old output', 3, false)
const outputKinds = () => http.get('/api/output-kinds', () => HttpResponse.json({ items: [dimmerOutput, relayOutput, oldOutput] }))

const system = (addressing: ProductType['addressing']) =>
  ({ id: 'pt-1', key: 'knx', name: { en: 'KNX' }, topology: addressing === 'none' ? 'none' : 'bus', addressing, isActive: true }) as unknown as ProductType
const systems = (addressing: ProductType['addressing']) => http.get('/api/product-types', () => HttpResponse.json({ items: [system(addressing)] }))

// The page lists channel kind names; the dialog loads the kinds and the
// systems (a KNX one by default, so the KNX objects show).
beforeEach(() => server.use(outputKinds(), systems('knx_individual')))

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
    expect(screen.queryByRole('button', { name: /new function/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    server.use(http.get('/api/function-types', () => HttpResponse.json({ items: [] })))
    renderWithProviders(<FunctionTypesPage />)

    expect(await screen.findByText('No functions yet.')).toBeInTheDocument()
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

    await user.click((await screen.findAllByRole('button', { name: /new function/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Key'), 'dimmer')
    await user.type((await translation(user, dialog, 'Name', 'en')), 'Dimmer')
    // Details start collapsed for a new function.
    await user.click(within(dialog).getByRole('button', { name: /details/i }))
    await user.click(await within(dialog).findByRole('checkbox', { name: 'LED' }))
    await user.click(within(dialog).getByRole('switch', { name: /share one channel/i }))
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ key: 'dimmer', name: { en: 'Dimmer' }, allowsCircuit: true, loadTypeIds: [led.id], outputKindIds: [], isActive: true, knxObjects: [] })
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

    await waitFor(() => expect(sent).toEqual({ key: 'dimming', name: { en: 'Dimmer', de: 'Dimmer' }, allowsCircuit: true, loadTypeIds: [led.id], outputKindIds: [], isActive: true, knxObjects: [] }))
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

    await user.click((await screen.findAllByRole('button', { name: /new function/i }))[0])
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

    await user.click((await screen.findAllByRole('button', { name: /new function/i }))[0])
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

    await user.click((await screen.findAllByRole('button', { name: /new function/i }))[0])
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

  it('edits the KNX objects: adds one with key, name and datapoint type, removes another', async () => {
    const stored: FunctionType = {
      ...dimmer,
      knxObjects: [
        { key: 'switch', name: { en: 'Switch', de: 'Schalten' }, dpst: 'DPST-1-1' },
        { key: 'old', name: { en: 'Old' }, dpst: 'DPST-1-1' },
      ],
    }
    let sent: { knxObjects?: unknown } | undefined
    server.use(
      loadTypes(),
      http.get('/api/function-types', () => HttpResponse.json({ items: [stored] })),
      http.put('/api/function-types/:id', async ({ request }) => {
        sent = (await request.json()) as typeof sent
        return HttpResponse.json(stored)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    const objects = await within(dialog).findByRole('group', { name: 'KNX objects' })
    await user.click(within(objects).getByRole('button', { name: /remove object 2/i }))
    await user.click(within(objects).getByRole('button', { name: 'Add object' }))
    const added = within(objects).getByRole('group', { name: 'Object 2' })
    await user.type(within(added).getByLabelText('Key'), 'brightness')
    await user.type(await translation(user, added, 'Name', 'en'), 'Brightness')
    const dpst = within(added).getByLabelText('Datapoint type')
    await user.clear(dpst)
    await user.type(dpst, 'DPST-5-1')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() =>
      expect(sent?.knxObjects).toEqual([
        { key: 'switch', name: { en: 'Switch', de: 'Schalten' }, dpst: 'DPST-1-1' },
        { key: 'brightness', name: { en: 'Brightness' }, dpst: 'DPST-5-1' },
      ]),
    )
  })

  it('validates the datapoint type of a KNX object', async () => {
    server.use(loadTypes(), http.get('/api/function-types', () => HttpResponse.json({ items: [dimmer] })))
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)
    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    // Collapsed: the function has no load types or objects yet.
    await user.click(within(dialog).getByRole('button', { name: /details/i }))
    const objects = await within(dialog).findByRole('group', { name: 'KNX objects' })
    await user.click(within(objects).getByRole('button', { name: 'Add object' }))
    const added = within(objects).getByRole('group', { name: 'Object 1' })
    await user.type(within(added).getByLabelText('Key'), 'switch')
    await user.type(await translation(user, added, 'Name', 'en'), 'Switch')
    const dpst = within(added).getByLabelText('Datapoint type')
    await user.clear(dpst)
    await user.type(dpst, 'DPT 1.001')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await within(added).findByText('Enter the datapoint subtype like DPST-1-1.')).toBeInTheDocument()
  })

  it('shows what serves each function, and warns when nothing does', async () => {
    server.use(
      http.get('/api/function-types', () =>
        HttpResponse.json({ items: [{ ...dimmer, outputKindIds: [dimmerOutput.id, relayOutput.id] }, { ...dimmer, id: 'x2', key: 'blind', name: { en: 'Blind' } }] }),
      ),
    )
    renderWithProviders(<FunctionTypesPage />)

    const served = (await screen.findByText('Dimmer output, Relay output')).closest('tr')!
    expect(within(served).getByText('dimmer')).toBeInTheDocument()
    const blind = screen.getByText('blind').closest('tr')!
    expect(within(blind).getByText('Not served')).toBeInTheDocument()
  })

  it('writes the channel kinds that serve the function, active ones in their order', async () => {
    let sent: { outputKindIds?: string[] } | undefined
    const stored = { ...dimmer, outputKindIds: [oldOutput.id] }
    server.use(
      loadTypes(),
      http.get('/api/function-types', () => HttpResponse.json({ items: [stored] })),
      http.put('/api/function-types/:id', async ({ request }) => {
        sent = (await request.json()) as typeof sent
        return HttpResponse.json(stored)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    const group = within(dialog).getByRole('group', { name: 'Served by channel kinds' })
    await within(group).findByRole('checkbox', { name: 'Dimmer output' })
    // The inactive kind it is linked to shows after the active ones.
    expect(within(group).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Dimmer output', 'Relay output', 'Old output'])
    await user.click(within(group).getByRole('checkbox', { name: 'Old output' }))
    expect(group).toHaveAccessibleDescription(/No channel kind serves this function yet/)
    await user.click(within(group).getByRole('checkbox', { name: 'Relay output' }))
    await user.click(within(group).getByRole('checkbox', { name: 'Dimmer output' }))
    expect(group).not.toHaveAccessibleDescription(/No channel kind serves/)
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(sent?.outputKindIds).toEqual([dimmerOutput.id, relayOutput.id]))
  })

  it('hides the KNX objects without a KNX system and keeps them on update', async () => {
    const stored: FunctionType = { ...dimmer, knxObjects: [{ key: 'switch', name: { en: 'Switch' }, dpst: 'DPST-1-1' }] }
    let sent: Record<string, unknown> | undefined
    server.use(
      loadTypes(),
      systems('eui64'),
      http.get('/api/function-types', () => HttpResponse.json({ items: [stored] })),
      http.put('/api/function-types/:id', async ({ request }) => {
        sent = (await request.json()) as typeof sent
        return HttpResponse.json(stored)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypesPage />)

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0])
    const dialog = await screen.findByRole('dialog')
    // Details open (the function has objects), but without a KNX system the editor is not shown.
    expect(await within(dialog).findByRole('checkbox', { name: 'LED' })).toBeVisible()
    expect(within(dialog).queryByRole('group', { name: 'KNX objects' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(sent).toBeDefined())
    expect(sent).not.toHaveProperty('knxObjects')
  })
})
