import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { ProjectListItem } from '@/api/generated/model'
import { userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProjectsPage } from './ProjectsPage'
import { acmeId, currencies, knx, problem, productTypes, tenant, tenants, villa, villaRow, zigbee } from './test-fixtures'

const oldId = '00000000-0000-4000-8000-0000000000a9'

function Probe() {
  const location = useLocation()
  return <p>at {location.pathname}</p>
}

const routes = (
  <Routes>
    <Route path="/projects" element={<ProjectsPage />} />
    <Route path="/projects/:id" element={<Probe />} />
  </Routes>
)

/** Serves the list and records the query of every request. */
function serveList(items: ProjectListItem[] = [villaRow]) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/projects', ({ request }) => {
      queries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items, total: items.length })
    }),
    http.get('/api/tenants', () => HttpResponse.json({ items: tenants })),
    http.get('/api/product-types', () => HttpResponse.json({ items: productTypes })),
    http.get('/api/currencies', () => HttpResponse.json(currencies)),
  )
  return queries
}

describe('ProjectsPage', () => {
  it('lists active projects with customer, tenant, status and versions; the name opens the project', async () => {
    const queries = serveList()
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })

    const row = (await screen.findByText('Villa Müller')).closest('[role="row"]') as HTMLElement
    expect(within(row).getByText('2026-0001')).toBeInTheDocument()
    expect(within(row).getByText('Müller GmbH')).toBeInTheDocument()
    expect(within(row).getByText('Acme')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(queries[0].get('status')).toBe('active')

    await user.click(within(row).getByRole('link', { name: 'Villa Müller' }))
    expect(await screen.findByText(`at /projects/${villa.id}`)).toBeInTheDocument()
  })

  it('marks projects of an archived tenant', async () => {
    serveList([villaRow, { ...villaRow, id: 'p2', name: 'Old Barn', tenant: { id: 't-old', name: 'Old', archived: true } }])
    renderWithProviders(routes, { route: '/projects' })

    const oldRow = (await screen.findByText('Old Barn')).closest('[role="row"]') as HTMLElement
    expect(within(oldRow).getByText('Old')).toBeInTheDocument()
    expect(within(oldRow).getByText('Archived')).toBeInTheDocument()
    const villaRowEl = screen.getByText('Villa Müller').closest('[role="row"]') as HTMLElement
    expect(within(villaRowEl).queryByText('Archived')).not.toBeInTheDocument()
  })

  it('filters by search, status and tenant through the URL', async () => {
    const queries = serveList()
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects?status=all' })
    await screen.findByText('Villa Müller')
    expect(queries.at(-1)!.get('status')).toBe('all')

    await user.type(screen.getByLabelText('Search'), 'villa')
    await waitFor(() => expect(queries.at(-1)!.get('search')).toBe('villa'))

    await user.click(screen.getByLabelText('Status'))
    await user.click(await screen.findByRole('option', { name: 'Completed' }))
    await waitFor(() => expect(queries.at(-1)!.get('status')).toBe('completed'))

    await user.click(screen.getByLabelText('Tenant'))
    await user.click(await screen.findByRole('option', { name: 'Acme' }))
    await waitFor(() => expect(queries.at(-1)!.get('tenantId')).toBe(acmeId))
  })

  it('offers archived tenants in the tenant filter, marked as archived', async () => {
    const queries = serveList()
    const tenantRequests: string[] = []
    server.use(
      http.get('/api/tenants', ({ request }) => {
        tenantRequests.push(new URL(request.url).search)
        return HttpResponse.json({ items: [...tenants, tenant({ id: oldId, name: 'Old', isActive: false, archivedAt: '2026-10-18T11:00:00Z' })] })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })
    await screen.findByText('Villa Müller')

    await user.click(screen.getByLabelText('Tenant'))
    await user.click(await screen.findByRole('option', { name: 'Old (archived)' }))
    await waitFor(() => expect(queries.at(-1)!.get('tenantId')).toBe(oldId))
    expect(tenantRequests).toContain('?includeArchived=true')
  })

  it('has no tenant column or filter for users of one tenant, and no Delete without projects.delete', async () => {
    serveList([{ ...villaRow, tenant: undefined, can: { update: true, delete: false, reopen: false } }])
    renderWithProviders(routes, { route: '/projects', me: userMe })

    const row = (await screen.findByText('Villa Müller')).closest('[role="row"]') as HTMLElement
    expect(screen.queryByLabelText('Tenant')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Tenant' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('shows an empty state with New project', async () => {
    serveList([])
    renderWithProviders(routes, { route: '/projects' })
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(2)
  })

  it('creates a project and opens it', async () => {
    serveList([])
    let posted: Record<string, unknown> | undefined
    server.use(
      http.post('/api/projects', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(villa, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })

    await user.click((await screen.findAllByRole('button', { name: 'New project' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    // Every active system is chosen; the inactive one is not offered.
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Zigbee/ })).toBeChecked())
    expect(within(dialog).getByRole('checkbox', { name: /KNX/ })).toBeChecked()
    expect(within(dialog).queryByRole('checkbox', { name: /Legacy/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('checkbox', { name: /KNX/ }))

    await user.type(within(dialog).getByLabelText(/^Name/, { selector: 'input[name="name"]' }), 'Villa Müller')
    // A new project gets its currency only: no rate field, no rate fetched (set later on the BOM or Pricing tab).
    const currency = within(dialog).getByRole('combobox', { name: /Currency/ })
    expect(currency).toHaveValue('USD – US Dollar')
    await user.click(currency)
    // USD first, then the tenant's recent currencies, then the rest by code.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'USD – US Dollar', 'PKR – Pakistani Rupee', 'EUR – Euro', 'CHF – Swiss Franc', 'JPY – Japanese Yen',
    ])
    await user.keyboard('euro')
    await user.click(screen.getByRole('option', { name: 'EUR – Euro' }))
    expect(within(dialog).queryByLabelText(/Exchange rate/)).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Company'), 'Müller GmbH')
    // The email is trimmed before it is checked, like the other fields.
    await user.type(within(dialog).getByLabelText('Email'), '  anna@example.com ')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(`at /projects/${villa.id}`)).toBeInTheDocument()
    expect(posted).not.toHaveProperty('exchangeRate')
    expect(posted).toMatchObject({
      name: 'Villa Müller',
      tenantId: '00000000-0000-4000-8000-0000000000d1',
      productTypeIds: [zigbee.id],
      language: 'en',
      currency: 'EUR',
      customer: { name: '', company: 'Müller GmbH', email: 'anna@example.com', phone: '', address: '' },
      notes: '',
    })
  })

  it('checks the form before sending it', async () => {
    serveList([])
    let posted = false
    server.use(
      http.post('/api/projects', () => {
        posted = true
        return HttpResponse.json(villa, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })

    await user.click((await screen.findAllByRole('button', { name: 'New project' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Zigbee/ })).toBeChecked())
    await user.click(within(dialog).getByRole('checkbox', { name: /Zigbee/ }))
    await user.click(within(dialog).getByRole('checkbox', { name: /KNX/ }))
    await user.type(within(dialog).getByLabelText('Email'), 'nope')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByText('Choose at least one system.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(posted).toBe(false)
  })

  it('edits a project loaded fresh, with its status, and shows field errors of the API', async () => {
    serveList()
    let put: Record<string, unknown> | undefined
    server.use(
      http.get('/api/projects/:id', () => HttpResponse.json({ ...villa, productTypeIds: [zigbee.id, knx.id] })),
      http.put('/api/projects/:id', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>
        if (put.name === 'Taken') return problem(422, { code: 'validation.failed', errors: [{ location: 'body.currency', code: 'project.currency_format' }] })
        return HttpResponse.json(villa)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })

    const row = (await screen.findByText('Villa Müller')).closest('[role="row"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' })
    expect(within(dialog).getByLabelText(/Exchange rate/)).toHaveValue('0.92')
    expect(within(dialog).getByLabelText('Address')).toHaveValue('Street 1\nCity')

    await user.click(within(dialog).getByLabelText('Status'))
    await user.click(await screen.findByRole('option', { name: 'Completed' }))
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(put).toMatchObject({ status: 'completed', expectedUpdatedAt: villa.updatedAt, productTypeIds: [zigbee.id, knx.id], exchangeRate: '0.92' })
  })

  it('deletes a project after asking', async () => {
    let items = [villaRow]
    serveList()
    server.use(
      http.get('/api/projects', () => HttpResponse.json({ items, total: items.length })),
      http.delete('/api/projects/:id', () => {
        items = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { route: '/projects' })

    const row = (await screen.findByText('Villa Müller')).closest('[role="row"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete project' })
    expect(dialog).toHaveTextContent('Delete project 2026-0001 Villa Müller with all its versions?')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument()
  })
})
