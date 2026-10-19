import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { BoardContent, Project } from '@/api/generated/model'
import { problem, villa } from '@/features/projects/test-fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { boardPath, boardRoute } from '../paths'
import { boardCaps, pid, plan, projectId, variant, versionId, zigbeeId } from '../test-fixtures'
import { BoardEditorPage } from './BoardEditorPage'

const project: Project = { ...villa, id: projectId, productTypeIds: [zigbeeId] }
const lock = { userId: 'me', name: 'Admin', expiresAt: '2026-10-18T10:02:00Z', mine: true }
const board = plan(2, { kind: 'board', name: 'Main board', image: null, board: { enclosureVariantId: null, moduleCount: 0, capacityTe: 12, usedTe: 0 } })
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
  rows: [{ id: row, capacityTe: 12, usedTe: 0 }],
  modules: [],
  capacityTe: 12,
  usedTe: 0,
  capabilities: {},
  warnings: [],
  ...over,
})

function serve(c = content(), p: Project = project) {
  const saved: { modules: { rowId: string; offsetTe: number; variantId: string }[] }[] = []
  server.use(
    http.get('/api/plans/:id', () => HttpResponse.json(board)),
    http.get('/api/plans/:id/board', () => HttpResponse.json(c)),
    http.get('/api/projects/:id', () => HttpResponse.json(p)),
    http.get('/api/variants', () => HttpResponse.json({ items: catalog, total: catalog.length })),
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

const open = () =>
  renderRoutes(
    [
      { path: `/${boardRoute}`, element: <BoardEditorPage /> },
      { path: '/projects/:id/versions/:versionId', element: <h1>Project page</h1> },
    ],
    { route: boardPath(projectId, versionId, board.id) },
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
    expect(screen.getByRole('tabpanel', { name: 'Inspector' })).toHaveTextContent('2 TE at 0.5 TE')
    await user.click(document.body)
    await user.keyboard('{Control>}z{/Control}')
    expect(screen.getByRole('tabpanel', { name: 'Inspector' })).toHaveTextContent('2 TE at 0 TE')

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
})
