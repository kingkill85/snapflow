import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AddressedItem, BoardContent, Checks, Project, Wiring } from '@/api/generated/model'
import { problem, villa } from '@/features/projects/test-fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { boardPath, boardRoute } from '../paths'
import { boardCaps, pid, plan, projectId, variant, versionId, zigbeeId } from '../test-fixtures'
import { BoardEditorPage } from './BoardEditorPage'

const project: Project = { ...villa, id: projectId, productTypeIds: [zigbeeId] }
const lock = { userId: 'me', name: 'Admin', expiresAt: '2026-10-18T10:02:00Z', mine: true }
const board = plan(2, { kind: 'board', name: 'Main board', image: null, board: { enclosureVariantId: null, moduleCount: 0, capacityTe: 12, usedTe: 0, sketch: { rows: [{ capacityTe: 12 }], modules: [] } } })
const row = pid(41)
const catalog = [
  variant(1, { productName: { en: 'Power supply' }, capabilities: boardCaps(2) }),
  variant(2, { productName: { en: 'Wall switch' } }),
]
const content = (over: Partial<BoardContent> = {}): BoardContent => ({
  planId: board.id,
  contentUpdatedAt: '2026-10-18T10:00:00Z',
  enclosureVariantId: null,
  rowsFromEnclosure: false,
  enclosureExisting: false,
  enclosureDeleted: false,
  rows: [{ id: row, capacityTe: 12, usedTe: 0 }],
  modules: [],
  capacityTe: 12,
  usedTe: 0,
  capabilities: {},
  warnings: [],
  ...over,
})

const addressedItem: AddressedItem = {
  planId: '',
  itemId: '',
  planKind: 'board',
  planName: 'Main board',
  label: 'D1',
  productName: { en: 'Power supply' },
  variantName: { en: 'PS' },
  modelNumber: 'PS-1',
  variantId: pid(1),
  systemId: pid(96),
  scheme: 'knx',
  existing: false,
  gateway: false,
  powerSupply: false,
}

const emptyWiring: Wiring = { items: [], needs: [], connections: [], can: { update: true } }
const emptyChecks: Checks = {
  versionId,
  counts: { errors: 0, warnings: 0, infos: 0, units: 0, connectedUnits: 0, zonesWithNeeds: 0, zonesCovered: 0 },
  zones: [],
  boards: [],
  busLines: [],
  gateways: [],
  findings: [],
}

function serve(c = content(), p: Project = project, wiring: Wiring = emptyWiring, checks: Checks = emptyChecks) {
  const saved: { modules: { rowId: string; offsetTe: number; variantId: string }[] }[] = []
  server.use(
    http.get('/api/versions/:v/wiring', () => HttpResponse.json(wiring)),
    http.get('/api/versions/:v/checks', () => HttpResponse.json(checks)),
    http.get('/api/versions/:v/addresses', () => HttpResponse.json({ versionId, items: [], lines: [], can: { update: true } })),
    http.get('/api/versions/:v/bus-lines', () => HttpResponse.json([])),
    http.get('/api/function-types', () => HttpResponse.json({ items: [] })),
    http.get('/api/plans/:id', () => HttpResponse.json(board)),
    http.get('/api/plans/:id/board', () => HttpResponse.json(c)),
    http.get('/api/projects/:id', () => HttpResponse.json(p)),
    http.get('/api/variants', ({ request }) => {
      // The board palette needs the capabilities (mounting, widths).
      if (new URL(request.url).searchParams.get('withCapabilities') !== 'true') return new HttpResponse(null, { status: 400 })
      return HttpResponse.json({ items: catalog, total: catalog.length })
    }),
    http.get('/api/output-kinds', () => HttpResponse.json({ items: [] })),
    http.get('/api/load-types', () => HttpResponse.json({ items: [] })),
    http.get('/api/products/:id', () => HttpResponse.json({ id: catalog[0].productId, variants: [{ id: catalog[0].id, addons: [] }] })),
    http.get('/api/categories/:id', () => HttpResponse.json({ id: catalog[0].categoryId, instanceAttributes: [] })),
    http.post('/api/plans/:id/lock', () => HttpResponse.json(lock)),
    http.delete('/api/plans/:id/lock', () => new HttpResponse(null, { status: 204 })),
    http.put('/api/plans/:id/board', async ({ request }) => {
      const body = (await request.json()) as (typeof saved)[number]
      saved.push(body)
      return HttpResponse.json({ ...c, contentUpdatedAt: '2026-10-18T10:01:00Z', modules: body.modules.map((m) => ({ ...m, widthTe: 2 })) })
    }),
  )
  return { saved }
}

const open = (query = '') =>
  renderRoutes(
    [
      { path: `/${boardRoute}`, element: <BoardEditorPage /> },
      { path: '/projects/:id/versions/:versionId', element: <h1>Project page</h1> },
    ],
    { route: boardPath(projectId, versionId, board.id) + query },
  )

describe('BoardEditorPage', () => {
  it('offers board products only, places one by keyboard, moves it, undoes, autosaves', async () => {
    const { saved } = serve()
    const user = userEvent.setup()
    open()

    const palette = await screen.findByRole('tabpanel', { name: 'Products' })
    expect(within(palette).getByRole('button', { name: /Power supply/ })).toBeInTheDocument()
    expect(within(palette).queryByText('Wall switch')).not.toBeInTheDocument()
    await waitFor(() => expect(within(palette).getByRole('button', { name: /Power supply/ })).toBeEnabled())

    // Arm the product, then Enter on the focused rail.
    await user.click(within(palette).getByRole('button', { name: /Power supply/ }))
    const rail = screen.getByRole('group', { name: 'Row 1: 0 of 12 TE used' })
    rail.focus()
    await user.keyboard('{Enter}')
    const placed = await screen.findByRole('button', { name: /^Power supply, 2 TE/ })
    expect(screen.getByTestId('board-totals')).toHaveTextContent('1 module · 2 / 12 TE')

    // Arrow right moves by half a TE; Ctrl+Z takes it back.
    await user.click(screen.getByRole('tab', { name: 'Inspector' }))
    placed.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tabpanel', { name: 'Inspector' })).toHaveTextContent('2 TE wide · at 0.5 TE')
    await user.click(document.body)
    await user.keyboard('{Control>}z{/Control}')
    expect(screen.getByRole('tabpanel', { name: 'Inspector' })).toHaveTextContent('2 TE wide · at 0 TE')

    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(saved.at(-1)).toMatchObject({ expectedContentUpdatedAt: '2026-10-18T10:00:00Z', modules: [{ rowId: row, offsetTe: 0, variantId: catalog[0].id }] })
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('a read-only project shows the board without editing', async () => {
    serve(content({ modules: [{ id: pid(70), rowId: row, offsetTe: 0, variantId: catalog[0].id, label: 'Q1', existing: true, addonVariantIds: [], instanceValues: {}, widthTe: 2 }] }), { ...project, status: 'completed' })
    open()
    expect(await screen.findByRole('button', { name: /^Power supply, Q1, 2 TE, Existing/ })).toBeInTheDocument()
    expect(screen.getByText('View only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('refuses a floorplan', async () => {
    server.use(http.get('/api/plans/:id', () => HttpResponse.json(plan(1))), http.get('/api/projects/:id', () => HttpResponse.json(project)), http.get('/api/variants', () => HttpResponse.json({ items: [], total: 0 })))
    open()
    expect(await screen.findByText('This plan does not exist (anymore).')).toBeInTheDocument()
  })

  it('shows a refused save at the module', async () => {
    serve()
    server.use(
      http.put('/api/plans/:id/board', () =>
        problem(422, { code: 'validation', fields: [{ location: 'body.modules[0].offsetTe', code: 'board.offset_invalid', params: { max: 999.9 } }] }),
      ),
    )
    const user = userEvent.setup()
    open()
    const palette = await screen.findByRole('tabpanel', { name: 'Products' })
    await waitFor(() => expect(within(palette).getByRole('button', { name: /Power supply/ })).toBeEnabled())
    await user.click(within(palette).getByRole('button', { name: /Power supply/ }))
    screen.getByRole('group', { name: 'Row 1: 0 of 12 TE used' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('1 item could not be saved:', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('shows channel use, the board check, and the channels of a module selected by ?select=', async () => {
    const dimmerKind = pid(60)
    const blindKind = pid(61)
    const relayKind = pid(62)
    const m = pid(70)
    const floor = pid(80)
    const need = pid(81)
    const conn = pid(90)
    const wiring: Wiring = {
      items: [
        {
          planId: board.id,
          planName: 'Main board',
          planKind: 'board',
          itemId: m,
          label: 'D1',
          productName: { en: 'Power supply' },
          variantName: { en: 'PS' },
          zoneId: null,
          channels: [
            { outputKindId: relayKind, outputKindKey: 'relay', channelNo: 1, alternative: false, baseKindKey: 'relay', baseFrom: 1, baseTo: 1, blocked: false, connectionIds: [conn] },
            { outputKindId: relayKind, outputKindKey: 'relay', channelNo: 2, alternative: false, baseKindKey: 'relay', baseFrom: 2, baseTo: 2, blocked: true, connectionIds: [] },
            { outputKindId: blindKind, outputKindKey: 'blind', channelNo: 1, alternative: true, baseKindKey: 'relay', baseFrom: 1, baseTo: 2, blocked: true, connectionIds: [] },
            { outputKindId: dimmerKind, outputKindKey: 'dimmer', channelNo: 1, alternative: false, baseKindKey: 'dimmer', baseFrom: 1, baseTo: 1, blocked: false, connectionIds: [] },
          ],
        },
      ],
      needs: [
        { planId: floor, planName: 'Ground floor', needId: need, zoneId: pid(82), zoneName: 'Kitchen', label: 'Spots', functionTypeId: pid(83), functionTypeKey: 'switched', quantity: 3, connectedUnits: 2, powerW: '10.00' },
      ],
      connections: [
        { id: conn, versionId, needPlanId: floor, needId: need, units: 2, targetPlanId: board.id, targetItemId: m, outputKindId: relayKind, channelNo: 1, pinned: true, batchId: null, createdAt: '2026-10-18T10:00:00Z' },
      ],
      can: { update: true },
    }
    const checks: Checks = {
      ...emptyChecks,
      boards: [
        {
          planId: board.id,
          name: 'Main board',
          channels: [{ outputKindId: relayKind, outputKindKey: 'relay', alternative: false, total: 2, used: 2, free: 0 }],
          rows: [],
          usedTe: 11,
          capacityTe: 12,
          status: 'amber',
        },
      ],
      findings: [
        {
          severity: 'error',
          code: 'channel_overload_a',
          refs: { targetPlanId: board.id, itemId: m, outputKindId: relayKind, channelNo: 1, connectionIds: [conn] },
          params: { currentA: 17.39, voltage: 230, limitA: 16, utilisationPercent: 109 },
        },
      ],
    }
    serve(content({ modules: [{ id: m, rowId: row, offsetTe: 0, variantId: catalog[0].id, label: 'D1', existing: false, addonVariantIds: [], instanceValues: {}, widthTe: 2 }] }), project, wiring, checks)
    server.use(
      http.get('/api/output-kinds', () =>
        HttpResponse.json({
          items: [
            { id: relayKind, key: 'relay', name: { en: 'Relay output' }, isActive: true },
            { id: blindKind, key: 'blind', name: { en: 'Blind output' }, isActive: true },
            { id: dimmerKind, key: 'dimmer', name: { en: 'Dimmer output' }, isActive: true },
          ],
        }),
      ),
      http.get('/api/function-types', () => HttpResponse.json({ items: [{ id: pid(83), key: 'switched', name: { en: 'Switched light' }, isActive: true }] })),
    )
    const deleted: string[] = []
    let candidates = 0
    server.use(
      http.delete('/api/versions/:v/connections/:id', ({ params }) => {
        deleted.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
      http.post('/api/versions/:v/connections/candidates', () => {
        candidates++
        return HttpResponse.json({ items: [], reason: 'complete' })
      }),
      // The module's KNX address on its line (read-only, D427).
      http.get('/api/versions/:v/addresses', () =>
        HttpResponse.json({
          versionId,
          items: [{ ...addressedItem, planId: board.id, itemId: m, busLineId: pid(95), address: { knx: '1.1.5', pinned: false } }],
          lines: [{ busLineId: pid(95), scheme: 'knx', prefix: '1.1', default: true, invalid: false, noPrefix: false }],
          can: { update: true },
        }),
      ),
      http.get('/api/versions/:v/bus-lines', () => HttpResponse.json([{ id: pid(95), versionId, productTypeId: pid(96), name: 'KNX 1', address: '', position: 1, devicesMax: null, createdAt: '', updatedAt: '' }])),
    )
    const user = userEvent.setup()
    const { router } = open(`?select=${m}`)

    // Module badge: physical channels only (the blind output is made of relays 1–2), used = connected or taken by an alternative.
    expect(await screen.findByRole('button', { name: /D1, 2 TE, 2 of 3 channels used/ })).toBeInTheDocument()
    expect(await screen.findByTestId('board-check')).toHaveTextContent('Near limit')

    // The inspector shows the module's channels: native first, then alternatives.
    const inspector = await screen.findByRole('tabpanel', { name: 'Inspector' })
    const channels = await within(inspector).findByRole('region', { name: 'Channels' })
    expect(within(channels).getByText('Relay output: 0 of 2 free')).toBeInTheDocument()
    expect(await within(inspector).findByText('KNX 1.1.5 · Line KNX 1')).toBeInTheDocument()
    expect(within(inspector).getByText('(automatic)')).toBeInTheDocument()
    // A channel with an error from the checks is marked, with the finding's text.
    const relay1 = within(channels).getByTestId(`channel-${relayKind}-1`)
    expect(within(relay1).getByText('1 error')).toBeInTheDocument()
    expect(within(relay1).getByText(/17\.39 A at 230 V connected, at most 16 A/)).toBeInTheDocument()
    // The deep link selected the module once and is removed from the URL (replace, D404).
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(router.state.historyAction).toBe('REPLACE')
    expect(within(channels).getByText('from Relay output 1–2')).toBeInTheDocument()
    expect(within(channels).getByText('Dimmer output: 1 of 1 free')).toBeInTheDocument()
    expect(within(channels).getByText('3 × Switched light · Spots')).toBeInTheDocument()
    expect(within(channels).getByText('Ground floor · Kitchen · 2 units · 20 W')).toBeInTheDocument()

    await user.click(within(channels).getByRole('button', { name: 'Disconnect 3 × Switched light · Spots' }))
    await waitFor(() => expect(deleted).toEqual([conn]))

    await user.click(within(channels).getByRole('button', { name: 'Connect a need to Dimmer output 1' }))
    expect(await screen.findByRole('dialog', { name: /Connect a need to/ })).toBeInTheDocument()
    await waitFor(() => expect(candidates).toBe(1))
  })
})
