import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Plan } from '@/api/generated/model'
import { problem } from '@/features/projects/test-fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { PlansSection } from './PlansSection'
import { plan, projectId, versionId } from './test-fixtures'

function servePlans(initial: Plan[]) {
  let plans = initial
  server.use(http.get('/api/versions/:versionId/plans', () => HttpResponse.json(plans)))
  return (next: Plan[]) => {
    plans = next
  }
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'floor.png', { type: 'image/png' })

describe('PlansSection', () => {
  it('lists the plans with thumbnail, counts and a link to the editor', async () => {
    servePlans([plan(1, { placementCount: 12, zoneCount: 3, needCount: 7 }), plan(2, { lock: { userId: 'u', name: 'Bea', expiresAt: '2026-10-18T10:02:00Z', mine: false } })])
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)

    const list = await screen.findByRole('list', { name: 'Plans' })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByRole('link', { name: 'Ground floor' })).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/plans/${plan(1).id}`)
    expect(within(cards[0]).getByText('Products: 12 · Zones: 3 · Needs: 7 units')).toBeInTheDocument()
    expect(within(cards[1]).getByText('Being edited by Bea')).toBeInTheDocument()
    expect(within(cards[0]).getByRole('button', { name: 'Move Ground floor left' })).toBeDisabled()
    expect(within(cards[1]).getByRole('button', { name: 'Move Floor 2 right' })).toBeDisabled()
  })

  it('shows the empty state and no actions when read-only', async () => {
    servePlans([])
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite={false} />)
    expect(await screen.findByText('No plans yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add plan' })).not.toBeInTheDocument()
  })

  it('hides card actions when read-only', async () => {
    servePlans([plan(1)])
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite={false} />)
    await screen.findByRole('link', { name: 'Ground floor' })
    expect(screen.queryByRole('button', { name: 'Edit Ground floor' })).not.toBeInTheDocument()
  })

  it('adds a plan with name and image, and needs both', async () => {
    const setPlans = servePlans([])
    let form: FormData | undefined
    server.use(
      http.post('/api/versions/:versionId/plans', async ({ request }) => {
        form = await request.formData()
        setPlans([plan(1)])
        return HttpResponse.json(plan(1), { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)

    await user.click(await screen.findByRole('button', { name: 'Add plan' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add plan' })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findAllByText('This field is required.')).toHaveLength(2)

    await user.type(within(dialog).getByLabelText(/^Name/), 'Ground floor')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findAllByText('This field is required.')).toHaveLength(1)

    await user.upload(within(dialog).getByLabelText('Floorplan image'), png())
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(form?.get('name')).toBe('Ground floor')
    expect(form?.get('image')).toMatchObject({ name: 'floor.png' })
    expect(await screen.findByRole('link', { name: 'Ground floor' })).toBeInTheDocument()
  })

  it('takes an image pasted into the dialog and refuses other file types', async () => {
    servePlans([])
    const user = userEvent.setup({ applyAccept: false })
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)
    await user.click(await screen.findByRole('button', { name: 'Add plan' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add plan' })

    await user.upload(within(dialog).getByLabelText('Floorplan image'), new File(['x'], 'plan.pdf', { type: 'application/pdf' }))
    expect(await within(dialog).findByText('Only JPEG, PNG and WebP images are accepted.')).toBeInTheDocument()

    within(dialog).getByLabelText(/^Name/).focus()
    await user.paste({ files: [png()] } as unknown as DataTransfer)
    await waitFor(() => expect(within(dialog).queryByText('Only JPEG, PNG and WebP images are accepted.')).not.toBeInTheDocument())
  })

  it('renames a plan and shows a taken name at the field', async () => {
    servePlans([plan(1)])
    let form: FormData | undefined
    server.use(
      http.put('/api/plans/:id', async ({ request }) => {
        form = await request.formData()
        return problem(409, { code: 'plan.name_taken', params: { name: 'Attic' }, fields: [{ location: 'body.name', code: 'plan.name_taken', params: { name: 'Attic' } }] })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)

    await user.click(await screen.findByRole('button', { name: 'Edit Ground floor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit plan' })
    const name = within(dialog).getByLabelText(/^Name/)
    await user.clear(name)
    await user.type(name, 'Attic')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    expect(await within(dialog).findByText('This version already has a plan named "Attic".')).toBeInTheDocument()
    expect(form?.get('name')).toBe('Attic')
    expect(form?.get('expectedUpdatedAt')).toBe(plan(1).updatedAt)
    expect(form?.has('image')).toBe(false)
  })

  it('moves a plan right', async () => {
    const setPlans = servePlans([plan(1), plan(2)])
    let ids: unknown
    server.use(
      http.put('/api/versions/:versionId/plans/order', async ({ request }) => {
        ids = ((await request.json()) as { ids: string[] }).ids
        setPlans([plan(2), plan(1)])
        return HttpResponse.json([plan(2), plan(1)])
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)

    await user.click(await screen.findByRole('button', { name: 'Move Ground floor right' }))
    await waitFor(() => expect(ids).toEqual([plan(2).id, plan(1).id]))
    await waitFor(() => expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Floor 2', 'Ground floor']))
  })

  it('deletes a plan after asking', async () => {
    const setPlans = servePlans([plan(1)])
    let deleted = false
    server.use(
      http.delete('/api/plans/:id', () => {
        deleted = true
        setPlans([])
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<PlansSection projectId={projectId} versionId={versionId} canWrite />)

    await user.click(await screen.findByRole('button', { name: 'Delete Ground floor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete plan' })
    expect(deleted).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('No plans yet.')).toBeInTheDocument()
    expect(deleted).toBe(true)
  })
})
