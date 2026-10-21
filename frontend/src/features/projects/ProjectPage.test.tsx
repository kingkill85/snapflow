import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { Project } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProjectPage } from './ProjectPage'
import { currencies, problem, productTypes, tenants, version, villa } from './test-fixtures'

function Path() {
  return <p data-testid="path">{useLocation().pathname}</p>
}

const routes = (
  <Routes>
    <Route path="/projects/:id" element={<><ProjectPage /><Path /></>} />
    <Route path="/projects/:id/versions/:versionId" element={<><ProjectPage /><Path /></>} />
  </Routes>
)

/** Serves the project (mutable through the returned setter). */
function serveProject(initial: Project = villa) {
  let project = initial
  server.use(
    http.get('/api/projects/:id', () => HttpResponse.json(project)),
    http.get('/api/projects', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/tenants', () => HttpResponse.json({ items: tenants })),
    http.get('/api/product-types', () => HttpResponse.json({ items: productTypes })),
    http.get('/api/currencies', () => HttpResponse.json(currencies)),
    http.get('/api/versions/:versionId/plans', () => HttpResponse.json([])),
  )
  return (next: Project) => {
    project = next
  }
}

describe('ProjectPage', () => {
  it('shows the project with its first version and no plans yet', async () => {
    serveProject()
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    expect(await screen.findByRole('heading', { name: '2026-0001 Villa Müller' })).toBeInTheDocument()
    expect(screen.getByText('Max Müller, Müller GmbH')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByLabelText('Version')).toHaveTextContent('V1')
    expect(await screen.findByText('Start with a floorplan (an image of the building) or a distribution board.')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /completed/ })).not.toBeInTheDocument()
    expect(screen.getByText('Project notes')).toBeInTheDocument()
    expect(screen.getByText('Gate code 1234')).toBeInTheDocument()
    expect(screen.queryByText('Version notes')).not.toBeInTheDocument()
    expect(screen.queryByText('Archived')).not.toBeInTheDocument()
  })

  it('labels the version notes and marks an archived tenant', async () => {
    serveProject({ ...villa, notes: '', tenant: { id: villa.tenantId, name: 'Acme', archived: true }, versions: [version(1, { notes: 'Cheaper offer' })] })
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    expect(await screen.findByText('Version notes')).toBeInTheDocument()
    expect(screen.getByText('Cheaper offer')).toBeInTheDocument()
    expect(screen.queryByText('Project notes')).not.toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('shows the version of the URL and switches versions', async () => {
    serveProject()
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}/versions/${version(2).id}` })

    expect(await screen.findByLabelText('Version')).toHaveTextContent('V2')
    await user.click(screen.getByLabelText('Version'))
    await user.click(await screen.findByRole('option', { name: 'V1' }))
    expect(screen.getByTestId('path')).toHaveTextContent(`/projects/${villa.id}/versions/${version(1).id}`)
  })

  it('creates a copy of the current version by default, with the next name', async () => {
    const setProject = serveProject()
    let posted: unknown
    const v3 = version(3)
    server.use(
      http.post('/api/projects/:id/versions', async ({ request }) => {
        posted = await request.json()
        setProject({ ...villa, versions: [...villa.versions, v3] })
        return HttpResponse.json(v3, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}/versions/${version(2).id}` })

    await user.click(await screen.findByRole('button', { name: 'New version' }))
    const dialog = await screen.findByRole('dialog', { name: 'New version' })
    expect(within(dialog).getByLabelText('Start from')).toHaveTextContent('Copy of V2')
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('V3')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(`/versions/${v3.id}`))
    expect(posted).toEqual({ name: 'V3', sourceVersionId: version(2).id })
    expect(await screen.findByLabelText('Version')).toHaveTextContent('V3')
  })

  it('creates an empty version', async () => {
    serveProject()
    let posted: unknown
    server.use(
      http.post('/api/projects/:id/versions', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(version(3, { name: 'Fresh' }), { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    await user.click(await screen.findByRole('button', { name: 'New version' }))
    const dialog = await screen.findByRole('dialog', { name: 'New version' })
    await user.click(within(dialog).getByLabelText('Start from'))
    await user.click(await screen.findByRole('option', { name: 'Empty version' }))
    const name = within(dialog).getByLabelText(/^Name/)
    await user.clear(name)
    await user.type(name, 'Fresh')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(posted).toEqual({ name: 'Fresh' }))
  })

  it('renames a version and says when the name is taken', async () => {
    serveProject()
    let put: Record<string, unknown> | undefined
    server.use(
      http.put('/api/projects/:id/versions/:versionId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>
        if (put.name === 'V2') return problem(409, { code: 'project_version.name_taken', params: { name: 'V2' } })
        return HttpResponse.json(version(1, { name: put.name as string }))
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    await user.click(await screen.findByRole('button', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename version' })
    const name = within(dialog).getByLabelText(/^Name/)
    await user.clear(name)
    await user.type(name, 'V2')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This project already has a version named "V2".')

    await user.clear(name)
    await user.type(name, 'Offer A')
    await user.type(within(dialog).getByLabelText('Notes'), 'Cheaper')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(put).toEqual({ name: 'Offer A', notes: 'Cheaper', expectedUpdatedAt: version(1).updatedAt })
  })

  it('deletes a version after asking and shows the first remaining one', async () => {
    const setProject = serveProject()
    let deleted = ''
    server.use(
      http.delete('/api/projects/:id/versions/:versionId', ({ params }) => {
        deleted = params.versionId as string
        setProject({ ...villa, versions: [version(1, { can: { update: true, delete: false } })] })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}/versions/${version(2).id}` })

    await user.click(await screen.findByRole('button', { name: 'Delete version' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete version' })
    expect(dialog).toHaveTextContent('Delete version V2 with everything in it?')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(new RegExp(`^/projects/${villa.id}$`)))
    expect(deleted).toBe(version(2).id)
    // The last version cannot be deleted: disabled, saying why.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete version' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Delete version' })).toHaveAccessibleDescription('The last version cannot be deleted. Delete the project instead.')
  })

  it('is read-only when completed and reopens it', async () => {
    const completed: Project = {
      ...villa,
      status: 'completed',
      versions: villa.versions.map((v) => ({ ...v, can: { update: false, delete: false } })),
      can: { update: false, delete: true, reopen: true },
    }
    const setProject = serveProject(completed)
    let put: Record<string, unknown> | undefined
    server.use(
      http.put('/api/projects/:id', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>
        setProject(villa)
        return HttpResponse.json(villa)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    expect(await screen.findByText('This project is completed. Reopen it to change it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New version' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(await screen.findByRole('button', { name: 'Edit project' })).toBeInTheDocument()
    expect(screen.queryByText('This project is completed. Reopen it to change it.')).not.toBeInTheDocument()
    expect(put).toMatchObject({ status: 'active', name: villa.name, currency: 'EUR', exchangeRate: '0.92', expectedUpdatedAt: villa.updatedAt })
  })

  it('offers no Reopen without permission to write', async () => {
    serveProject({ ...villa, status: 'cancelled', can: { update: false, delete: false, reopen: false } })
    renderWithProviders(routes, { route: `/projects/${villa.id}` })
    expect(await screen.findByText('This project is cancelled. Reopen it to change it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument()
  })

  it('edits the project from its page', async () => {
    serveProject()
    let put: Record<string, unknown> | undefined
    server.use(
      http.put('/api/projects/:id', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ...villa, name: put.name })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: `/projects/${villa.id}` })

    await user.click(await screen.findByRole('button', { name: 'Edit project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' })
    const name = within(dialog).getByLabelText(/^Name/, { selector: 'input[name="name"]' })
    await user.clear(name)
    await user.type(name, 'Villa Schmidt')
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await screen.findByRole('heading', { name: '2026-0001 Villa Schmidt' })).toBeInTheDocument()
    expect(put).toMatchObject({ name: 'Villa Schmidt', status: 'active', tenantId: villa.tenantId })
  })

  it('says when the project does not exist', async () => {
    server.use(http.get('/api/projects/:id', () => problem(404, { code: 'project.not_found' })))
    renderWithProviders(routes, { route: `/projects/${villa.id}` })
    expect(await screen.findByText('This project does not exist or you cannot see it.')).toBeInTheDocument()
  })

  it('splits the Documents tab by audience, the customer first', async () => {
    serveProject()
    server.use(
      http.get('/api/versions/:versionId/proposals', () => HttpResponse.json([])),
      http.get('/api/versions/:versionId/documents', () => HttpResponse.json([])),
      http.get('/api/versions/:versionId/addresses', () => HttpResponse.json({ versionId: villa.versions[0].id, items: [], lines: [], can: { update: true } })),
      http.get('/api/versions/:versionId/bom', () => HttpResponse.json({ lines: [] })),
      http.get('/api/exporters', () => HttpResponse.json([])),
    )
    renderWithProviders(routes, { route: `/projects/${villa.id}/versions/${villa.versions[0].id}?tab=documents` })
    const customer = await screen.findByRole('region', { name: 'For the customer' })
    const installer = screen.getByRole('region', { name: 'For the installer' })
    expect(customer).toHaveTextContent('Proposals with prices for this version.')
    expect(installer).toHaveTextContent('Manual, channel labels and programming data for the site.')
    expect(customer.compareDocumentPosition(installer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(customer).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0)
    expect(within(installer).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(1)
  })
})
