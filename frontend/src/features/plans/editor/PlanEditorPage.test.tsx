import type { QueryClient } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { Checks, OutputKind, PlanContent, Project, Wiring } from '@/api/generated/model'
import { problem, villa } from '@/features/projects/test-fixtures'
import { renderRoutes } from '@/test/render'
import { chooseOption } from '@/test/select'
import { server } from '@/test/server'

import { editorPath, editorRoute } from '../paths'
import { getGetPlanContentQueryKey, getGetPlanQueryKey } from '@/api/generated/plans/plans'
import { getGetProjectQueryKey } from '@/api/generated/projects/projects'

import { catalog, content, functionTypes, loadTypes, pid, placement, plan, projectId, roomTemplate, versionId, zigbeeId } from '../test-fixtures'
import { newNeed } from './needs'
import { PlanEditorPage } from './PlanEditorPage'

// Konva needs a real canvas: the page is tested with a stand-in that places
// at a fixed point and shows what the canvas would draw.
vi.mock('./PlanCanvas', () => ({
  productDragType: 'application/x-snapflow-product',
  PlanCanvas: (props: {
    document: { placements: unknown[]; needs: unknown[] }
    editable: boolean
    tool: string
    layers: { needsHidden: boolean }
    onPlace: (p: { x: number; y: number }) => void
    onPlaceNeed: (p: { x: number; y: number }) => void
  }) => (
    <div
      data-testid="plan-canvas"
      data-count={props.document.placements.length}
      data-needs={props.document.needs.length}
      data-tool={props.tool}
      data-needs-hidden={String(props.layers.needsHidden)}
      data-editable={String(props.editable)}
    >
      <span role="button" tabIndex={0} onClick={() => (props.tool === 'placeNeed' ? props.onPlaceNeed({ x: 120, y: 80 }) : props.onPlace({ x: 300, y: 200 }))}>
        place here
      </span>
    </div>
  ),
}))

const project: Project = { ...villa, id: projectId, productTypeIds: [zigbeeId] }
const lock = { userId: 'me', name: 'Admin', expiresAt: '2026-10-18T10:02:00Z', mine: true }

type Serve = { project?: Project; content?: PlanContent; lockHeld?: boolean; wiring?: Wiring; checks?: Checks }

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

/** The editor's endpoints; returns what was saved and how the lock was taken. */
function serve({ project: p = project, content: c = content(), lockHeld = false, wiring = emptyWiring, checks = emptyChecks }: Serve = {}) {
  const saved: unknown[] = []
  const deleted: string[] = []
  const locks: string[] = []
  let held = lockHeld
  server.use(
    http.get('/api/plans/:id', () => HttpResponse.json(plan(1))),
    http.get('/api/plans/:id/content', () => HttpResponse.json(c)),
    http.get('/api/projects/:id', () => HttpResponse.json(p)),
    http.get('/api/variants', () => HttpResponse.json({ items: catalog, total: catalog.length })),
    http.get('/api/function-types', () => HttpResponse.json({ items: functionTypes })),
    http.get('/api/load-types', () => HttpResponse.json({ items: loadTypes })),
    http.get('/api/room-templates', () => HttpResponse.json({ items: [roomTemplate(1)] })),
    http.get('/api/versions/:v/wiring', () => HttpResponse.json(wiring)),
    http.get('/api/versions/:v/checks', () => HttpResponse.json(checks)),
    http.get('/api/output-kinds', () => HttpResponse.json({ items: [outputKind] })),
    http.delete('/api/versions/:v/connections/:id', ({ params }) => {
      deleted.push(String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('/api/plans/:id/lock', ({ request }) => {
      const force = new URL(request.url).searchParams.get('force') === 'true'
      locks.push(force ? 'force' : 'take')
      if (held && !force) return problem(409, { code: 'plan.locked', params: { name: 'Bea', expiresAt: '2026-10-18T10:02:00Z' } })
      held = false
      return HttpResponse.json(lock)
    }),
    http.delete('/api/plans/:id/lock', () => new HttpResponse(null, { status: 204 })),
    http.put('/api/plans/:id/content', async ({ request }) => {
      const body = (await request.json()) as { placements: unknown[]; needs: unknown[] }
      saved.push(body)
      return HttpResponse.json({ ...c, contentUpdatedAt: '2026-10-18T10:01:00Z', placements: body.placements, needs: body.needs })
    }),
  )
  return { saved, locks, deleted }
}

const open = (prepare?: (client: QueryClient) => void, query = '') =>
  renderRoutes(
    [
      { path: `/${editorRoute}`, element: <PlanEditorPage /> },
      { path: '/projects/:id/versions/:versionId', element: <h1>Project page</h1> },
    ],
    { route: editorPath(projectId, versionId, plan(1).id) + query, prepare },
  )

describe('PlanEditorPage', () => {
  it('says a board does not exist on the floorplan route, without asking for floorplan content', async () => {
    // No handler for /content: a request for it would fail the test.
    server.use(
      http.get('/api/plans/:id', () => HttpResponse.json(plan(1, { kind: 'board', image: null }))),
      http.get('/api/projects/:id', () => HttpResponse.json(project)),
      http.get('/api/variants', () => HttpResponse.json({ items: catalog, total: catalog.length })),
    )
    open()
    expect(await screen.findByText('This plan does not exist (anymore).')).toBeInTheDocument()
  })

  it('takes the lock, places a palette product and autosaves it', async () => {
    const { saved, locks } = serve()
    const user = userEvent.setup()
    open()

    const palette = await screen.findByRole('tabpanel', { name: 'Products' })
    // Only the project's product types, by category.
    expect(within(palette).getByRole('region', { name: 'Switches' })).toBeInTheDocument()
    expect(within(palette).queryByText('KNX switch')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    expect(locks).toEqual(['take'])
    expect(screen.getByText('Saved')).toBeInTheDocument()

    await user.click(within(palette).getByRole('button', { name: /Motion sensor/ }))
    expect(within(palette).getByRole('button', { name: /Motion sensor/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'place here' }))

    // Placed and selected; the palette stays open for the next one.
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '1')
    expect(within(palette).getByRole('button', { name: /Motion sensor/ })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('tab', { name: 'Inspector' }))
    const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
    expect(within(inspector).getByText('Motion sensor')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ expectedContentUpdatedAt: content().contentUpdatedAt, placements: [{ variantId: catalog[2].id, x: 300, y: 200, height: 60 }] })
    expect(await screen.findByText('Saved')).toBeInTheDocument()

    // Undo is one step back, saved again.
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '0')
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1]).toMatchObject({ expectedContentUpdatedAt: '2026-10-18T10:01:00Z', placements: [] })
  })

  it('starts from the stored content, not from a cached copy of an earlier visit', async () => {
    const { saved } = serve()
    const user = userEvent.setup()
    // The previous visit left an older content in the cache.
    open((client) => {
      client.setQueryData(getGetPlanQueryKey(plan(1).id), plan(1))
      client.setQueryData(getGetProjectQueryKey(projectId), project)
      client.setQueryData(['/api/variants', 'plan-editor'], catalog)
      client.setQueryData(getGetPlanContentQueryKey(plan(1).id), { ...content(), contentUpdatedAt: '2026-10-18T09:00:00Z' })
    })

    const palette = await screen.findByRole('tabpanel', { name: 'Products' })
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(within(palette).getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ expectedContentUpdatedAt: content().contentUpdatedAt })
  })

  it('edits the selected placement in the inspector', async () => {
    const { saved } = serve({ content: content({ placements: [placement(1, { variantId: catalog[0].id })] }) })
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('tab', { name: 'Inspector' }))
    const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
    expect(within(inspector).getByText('Wall switch')).toBeInTheDocument()

    await user.type(within(inspector).getByLabelText('Label'), 'L1')
    // Typing in a field: shortcuts stay off (Ctrl+A selects the text, Delete deletes characters).
    await user.keyboard('{Backspace}')
    expect(within(inspector).getByLabelText('Label')).toHaveValue('L')
    await user.click(within(inspector).getByRole('switch', { name: /Existing/ }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ placements: [{ label: 'L', existing: true }] })
  })

  it('is read-only while someone else holds the lock, and takes it over', async () => {
    const { locks } = serve({ lockHeld: true })
    const user = userEvent.setup()
    open()
    expect(await screen.findByText(/Being edited by Bea until/)).toBeInTheDocument()
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByText('View only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Take over' }))
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    expect(screen.queryByText(/Being edited by Bea/)).not.toBeInTheDocument()
    expect(locks).toEqual(['take', 'force'])
  })

  it('opens completed projects read-only without taking the lock', async () => {
    const { locks } = serve({ project: { ...project, status: 'completed' } })
    open()
    expect(await screen.findByText(/can only be viewed/)).toBeInTheDocument()
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'false')
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument()
    expect(locks).toEqual([])
  })

  it('offers a reload when the plan changed elsewhere', async () => {
    serve()
    server.use(http.put('/api/plans/:id/content', () => problem(409, { code: 'plan.stale' })))
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))
    await user.click(await screen.findByRole('button', { name: 'Reload plan' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '0'))
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('shows a save refused for an item at that item', async () => {
    serve()
    server.use(
      http.put('/api/plans/:id/content', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'body.placements[0].variantId', code: 'plan.variant_not_found' }] }),
      ),
    )
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))
    expect(await screen.findByText('Save failed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('1 item could not be saved:')).toBeInTheDocument()
    const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
    expect(within(inspector).getByRole('alert')).toBeInTheDocument()
  })

  it('saves pending changes when leaving, without asking', async () => {
    const { saved } = serve()
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    // Leaving before the autosave's debounce: saved at once, then the page changes.
    await user.click(screen.getByRole('link', { name: new RegExp(villa.name) }))
    expect(await screen.findByRole('heading', { name: 'Project page' })).toBeInTheDocument()
    // (The previous test's editor may also save on unmount into this test's handler.)
    expect(saved.length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument()
  })

  it('asks before discarding changes that cannot be saved', async () => {
    serve()
    server.use(http.put('/api/plans/:id/content', () => problem(500, { code: 'internal' })))
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))

    const back = screen.getByRole('link', { name: new RegExp(villa.name) })
    await user.click(back)
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    // Stay keeps the editor and its changes.
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '1')

    // Leave page discards them.
    await user.click(back)
    await user.click(within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Leave page' }))
    expect(await screen.findByRole('heading', { name: 'Project page' })).toBeInTheDocument()
  })

  it('places a load symbol with the Place need tool (last used or first active function) and hides symbols with the Needs layer', async () => {
    const { saved } = serve()
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))

    await user.click(screen.getByRole('button', { name: 'Place need' }))
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-tool', 'placeNeed')
    expect(screen.getByRole('button', { name: 'Place need' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Click on the plan to place the need symbol; Esc cancels.')).toBeInTheDocument()
    // The first active function type is preselected.
    const select = await screen.findByRole('combobox', { name: 'Function type of the next symbol' })
    await waitFor(() => expect(select).toHaveTextContent('Dimmable light'))
    await chooseOption(user, select, 'Blind')
    await user.click(screen.getByRole('button', { name: 'place here' }))

    // Placed, selected (inspector) and back to Select.
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs', '1')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-tool', 'select')
    const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
    expect(within(inspector).getByText('Need symbol')).toBeInTheDocument()
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ needs: [{ functionTypeId: functionTypes[1].id, x: 120, y: 80, quantity: 1, zoneId: null }] })

    // The next time the last used one is chosen.
    await user.click(screen.getByRole('button', { name: 'Place need' }))
    expect(screen.getByRole('combobox', { name: 'Function type of the next symbol' })).toHaveTextContent('Blind')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('tab', { name: 'Layers' }))
    await user.click(screen.getByRole('switch', { name: /Need symbols/ }))
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs-hidden', 'true')
  })

  it('hides the tool overlays while the plan is read-only', async () => {
    serve({ lockHeld: true })
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'false'))
    expect(screen.queryByRole('combobox', { name: 'Function type of the next symbol' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Esc cancels/)).not.toBeInTheDocument()
  })

  it('duplicates placements and symbols in one step, skipping symbols with an inactive function type', async () => {
    const symbolOk = { ...need(1), x: 100, y: 100, zoneId: null }
    const symbolOld = { ...need(2), functionTypeId: functionTypes[2].id, x: 200, y: 100, zoneId: null }
    const { saved } = serve({ content: content({ placements: [placement(1)], needs: [symbolOk, symbolOld] }) })
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))

    await user.keyboard('{Control>}a{/Control}')
    await user.keyboard('{Control>}d{/Control}')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs', '3')
    expect(screen.getByText('1 need symbol was not copied: its function type or load type is inactive.')).toBeInTheDocument()

    // One undo step takes back the placement and the symbol.
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-count', '1')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs', '2')
    expect(screen.queryByText(/was not copied/)).not.toBeInTheDocument()

    // Copy and paste works the same way.
    await user.keyboard('{Control>}a{/Control}{Control>}c{/Control}{Control>}v{/Control}')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs', '3')
    expect(screen.getByText('1 need symbol was not copied: its function type or load type is inactive.')).toBeInTheDocument()
    await waitFor(() => expect(saved.length).toBeGreaterThanOrEqual(1))
  })

  it('sends a need that undo brings back after a saved delete as restored', async () => {
    const old = { ...need(2), functionTypeId: functionTypes[2].id, x: 200, y: 100, zoneId: null }
    const { saved } = serve({ content: content({ needs: [old] }) })
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))

    await user.keyboard('{Control>}a{/Control}{Delete}')
    expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-needs', '0')
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ needs: [], restoredNeedIds: [] })
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1]).toMatchObject({ needs: [{ id: old.id }], restoredNeedIds: [old.id] })
  })

  it('names a need in the list of items that could not be saved', async () => {
    serve({ content: content({ needs: [{ ...need(1), quantity: 2, powerW: '7.50', x: 100, y: 100, zoneId: null }] }) })
    server.use(
      http.put('/api/plans/:id/content', () => problem(422, { code: 'validation.failed', fields: [{ location: 'body.needs[0].functionTypeId', code: 'need.function_type_inactive' }] })),
    )
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
    await user.click(screen.getByRole('button', { name: 'place here' }))
    expect(await screen.findByText('1 item could not be saved:', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 × Dimmable light · 7.5 W' })).toBeInTheDocument()
  })

  it('says how many needs a deleted zone took along', async () => {
    const z = { id: pid(950), name: 'Living', color: '#3b82f6', opacity: 0.25, points: [[0, 0], [100, 0], [100, 100], [0, 100]] }
    serve({ content: content({ zones: [z], needs: [{ ...need(1), zoneId: z.id }, { ...need(2), zoneId: z.id }] }) })
    const user = userEvent.setup()
    open()
    await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
    await user.click(screen.getByRole('tab', { name: 'Zones' }))
    await user.click(within(screen.getByRole('tabpanel', { name: 'Zones' })).getByRole('button', { name: 'Living' }))
    const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
    await user.click(within(inspector).getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('2 needs were removed with their zone (Undo brings them back).')).toBeInTheDocument()
  })

  describe('connections (3d)', () => {
    const z = { id: pid(950), name: 'Living', color: '#3b82f6', opacity: 0.25, points: [[0, 0], [100, 0], [100, 100], [0, 100]] }
    const board = pid(600)
    const module = pid(601)
    const wired = (connected: number): Wiring => ({
      items: [
        {
          planId: board,
          planName: 'Main board',
          planKind: 'board',
          itemId: module,
          label: 'D1',
          productName: { en: 'Dimmer' },
          variantName: { en: '2-fold' },
          zoneId: null,
          channels: [
            { outputKindId: outputKind.id, outputKindKey: 'dimmer_output', channelNo: 1, alternative: false, baseKindKey: 'dimmer_output', baseFrom: 1, baseTo: 1, blocked: false, connectionIds: connected ? [pid(700)] : [] },
          ],
        },
      ],
      needs: [
        { planId: plan(1).id, planName: 'Ground', needId: pid(1301), zoneId: z.id, zoneName: 'Living', label: '', functionTypeId: functionTypes[0].id, functionTypeKey: 'dimmable_light', quantity: 3, connectedUnits: connected, powerW: null },
      ],
      connections: connected
        ? [{ id: pid(700), versionId, needPlanId: plan(1).id, needId: pid(1301), units: connected, targetPlanId: board, targetItemId: module, outputKindId: outputKind.id, channelNo: 1, pinned: true, batchId: null, createdAt: '2026-10-18T10:00:00Z' }]
        : [],
      can: { update: true },
    })
    const checked = (connected: number): Checks => ({
      ...emptyChecks,
      zones: [{ planId: plan(1).id, zoneId: z.id, name: 'Living', units: 3, connectedUnits: connected, status: connected === 0 ? 'missing' : connected < 3 ? 'partial' : 'covered' }],
    })

    it('shows the zone status in the Zones tab and the need connections with Disconnect', async () => {
      const { deleted } = serve({ content: content({ zones: [z], needs: [{ ...need(1), zoneId: z.id, quantity: 3 }] }), wiring: wired(2), checks: checked(2) })
      const user = userEvent.setup()
      open()
      await waitFor(() => expect(screen.getByTestId('plan-canvas')).toHaveAttribute('data-editable', 'true'))
      await user.click(screen.getByRole('tab', { name: 'Zones' }))
      expect(await within(screen.getByTestId(`zone-status-${z.id}`)).findByText('2/3')).toBeInTheDocument()

      await user.click(within(screen.getByRole('tabpanel', { name: 'Zones' })).getByRole('button', { name: 'Living' }))
      const inspector = screen.getByRole('tabpanel', { name: 'Inspector' })
      expect(within(inspector).getByText('2 × → D1 · Dimmer output 1 (Main board)')).toBeInTheDocument()
      await user.click(within(inspector).getByRole('button', { name: 'Disconnect 2 × → D1 · Dimmer output 1 (Main board)' }))
      await waitFor(() => expect(deleted).toEqual([pid(700)]))
    })

    it('opens the connect picker for a need with unconnected units', async () => {
      serve({ content: content({ zones: [z], needs: [{ ...need(1), zoneId: z.id, quantity: 3 }] }), wiring: wired(0), checks: checked(0) })
      server.use(
        http.post('/api/versions/:v/connections/candidates', () =>
          HttpResponse.json({
            items: [{ needPlanId: plan(1).id, needId: pid(1301), targetPlanId: board, targetItemId: module, outputKindId: outputKind.id, channelNo: 1, units: 3, free: true, inZone: false }],
          }),
        ),
      )
      const user = userEvent.setup()
      const { router } = open(undefined, `?select=${pid(1301)}`)
      // ?select= of a need without position selects its zone and opens the inspector.
      const inspector = await screen.findByRole('tabpanel', { name: 'Inspector' })
      expect(await within(inspector).findByText('Not connected')).toBeInTheDocument()
      // The deep link is removed from the URL once applied (replace, D404).
      await waitFor(() => expect(router.state.location.search).toBe(''))
      expect(router.state.historyAction).toBe('REPLACE')
      await user.click(within(inspector).getByRole('button', { name: /^Connect 3 × Dimmable light/ }))
      const dialog = await screen.findByRole('dialog')
      expect(await within(dialog).findByText('D1 · Dimmer output 1 (Main board)')).toBeInTheDocument()
      expect(within(dialog).getByText('3 units')).toBeInTheDocument()
    })

    it('says a need not saved yet gets its connections after the save', async () => {
      serve({ content: content({ zones: [z], needs: [{ ...need(1), zoneId: z.id }] }), wiring: emptyWiring })
      open(undefined, `?select=${z.id}`)
      const inspector = await screen.findByRole('tabpanel', { name: 'Inspector' })
      expect(await within(inspector).findByText('Connections after the next save')).toBeInTheDocument()
    })
  })
})

const outputKind: OutputKind = {
  id: pid(1500),
  key: 'dimmer_output',
  name: { en: 'Dimmer output' },
  isActive: true,
  functionTypeIds: [pid(1001)],
  alternatives: [],
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  can: { update: true, delete: true },
} as unknown as OutputKind

/** A need of the fixtures' first function type. */
const need = (n: number) => ({ ...newNeed(functionTypes[0].id, null), id: pid(1300 + n) })
