import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { PlanContent, Project } from '@/api/generated/model'
import { problem, villa } from '@/features/projects/test-fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { editorPath, editorRoute } from '../paths'
import { catalog, content, placement, plan, projectId, versionId, zigbeeId } from '../test-fixtures'
import { PlanEditorPage } from './PlanEditorPage'

// Konva needs a real canvas: the page is tested with a stand-in that places
// at a fixed point and shows what the canvas would draw.
vi.mock('./PlanCanvas', () => ({
  productDragType: 'application/x-snapflow-product',
  PlanCanvas: (props: { document: { placements: unknown[] }; editable: boolean; onPlace: (p: { x: number; y: number }) => void }) => (
    <div data-testid="plan-canvas" data-count={props.document.placements.length} data-editable={String(props.editable)}>
      <span role="button" tabIndex={0} onClick={() => props.onPlace({ x: 300, y: 200 })}>
        place here
      </span>
    </div>
  ),
}))

const project: Project = { ...villa, id: projectId, productTypeIds: [zigbeeId] }
const lock = { userId: 'me', name: 'Admin', expiresAt: '2026-10-18T10:02:00Z', mine: true }

type Serve = { project?: Project; content?: PlanContent; lockHeld?: boolean }

/** The editor's endpoints; returns what was saved and how the lock was taken. */
function serve({ project: p = project, content: c = content(), lockHeld = false }: Serve = {}) {
  const saved: unknown[] = []
  const locks: string[] = []
  let held = lockHeld
  server.use(
    http.get('/api/plans/:id', () => HttpResponse.json(plan(1))),
    http.get('/api/plans/:id/content', () => HttpResponse.json(c)),
    http.get('/api/projects/:id', () => HttpResponse.json(p)),
    http.get('/api/variants', () => HttpResponse.json({ items: catalog, total: catalog.length })),
    http.post('/api/plans/:id/lock', ({ request }) => {
      const force = new URL(request.url).searchParams.get('force') === 'true'
      locks.push(force ? 'force' : 'take')
      if (held && !force) return problem(409, { code: 'plan.locked', params: { name: 'Bea', expiresAt: '2026-10-18T10:02:00Z' } })
      held = false
      return HttpResponse.json(lock)
    }),
    http.delete('/api/plans/:id/lock', () => new HttpResponse(null, { status: 204 })),
    http.put('/api/plans/:id/content', async ({ request }) => {
      const body = (await request.json()) as { placements: unknown[] }
      saved.push(body)
      return HttpResponse.json({ ...c, contentUpdatedAt: '2026-10-18T10:01:00Z', placements: body.placements })
    }),
  )
  return { saved, locks }
}

const open = () =>
  renderRoutes(
    [
      { path: `/${editorRoute}`, element: <PlanEditorPage /> },
      { path: '/projects/:id/versions/:versionId', element: <h1>Project page</h1> },
    ],
    { route: editorPath(projectId, versionId, plan(1).id) },
  )

describe('PlanEditorPage', () => {
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
})
