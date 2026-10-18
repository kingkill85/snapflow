import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Tenant } from '@/api/generated/model'
import { getListUsersQueryKey } from '@/api/generated/users/users'
import { adminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { TenantsPage } from './TenantsPage'

const tenant = (over: Partial<Tenant>): Tenant => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Acme',
  isDistributor: false,
  isActive: true,
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  projectCount: 0,
  can: { update: true, delete: true },
  ...over,
})

const distributor = tenant({ id: '00000000-0000-4000-8000-0000000000d1', name: 'Distributor', isDistributor: true, can: { update: true, delete: false } })

describe('TenantsPage', () => {
  it('lists tenants and protects the distributor', async () => {
    server.use(http.get('/api/tenants', () => HttpResponse.json({ items: [distributor, tenant({ isActive: false })] })))
    renderWithProviders(<TenantsPage />)

    const dist = (await screen.findByText('Distributor', { selector: 'td' })).closest('tr')!
    expect(within(dist).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()

    const acme = screen.getByText('Acme').closest('tr')!
    expect(within(acme).getByText('Partner')).toBeInTheDocument()
    expect(within(acme).getByText('Inactive')).toBeInTheDocument()
    expect(within(acme).getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('creates a tenant', async () => {
    let items: Tenant[] = [distributor]
    let posted: unknown
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items })),
      http.post('/api/tenants', async ({ request }) => {
        posted = await request.json()
        items = [distributor, tenant({})]
        return HttpResponse.json(items[1], { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />)

    await user.click(await screen.findByRole('button', { name: /new tenant/i }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Acme')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({ name: 'Acme', isActive: true })
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })

  it('warns that deleting a tenant deletes its users', async () => {
    server.use(http.get('/api/tenants', () => HttpResponse.json({ items: [tenant({})] })))
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />)

    await user.click(await screen.findByRole('button', { name: /delete/i }))
    expect(await screen.findByText('Delete "Acme" and all its users? This cannot be undone.')).toBeInTheDocument()
  })

  it('deactivates a partner', async () => {
    let put: unknown
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [tenant({})] })),
      http.put('/api/tenants/:id', async ({ request }) => {
        put = await request.json()
        return HttpResponse.json(tenant({ isActive: false }))
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />)

    await user.click(await screen.findByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByLabelText('Active'))
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(put).toEqual({ name: 'Acme', isActive: false })
  })

  it('explains instead of offering to deactivate the distributor, and refreshes the session for the own tenant', async () => {
    let meReloaded = false
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [distributor] })),
      http.put('/api/tenants/:id', () => HttpResponse.json(distributor)),
      http.get('/api/auth/me', () => {
        meReloaded = true
        return HttpResponse.json(adminMe)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />, { me: adminMe })

    await user.click(await screen.findByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('The distributor tenant always stays active.')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Active')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(meReloaded).toBe(true)
  })

  it('refreshes the user list after deleting a tenant', async () => {
    let items = [tenant({})]
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items })),
      http.delete('/api/tenants/:id', () => {
        items = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    const { client } = renderWithProviders(<TenantsPage />)
    client.setQueryData(getListUsersQueryKey(), { items: [] })

    await user.click(await screen.findByRole('button', { name: /delete/i }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(client.getQueryState(getListUsersQueryKey())?.isInvalidated).toBe(true)
    expect(await screen.findByText('No tenants yet.')).toBeInTheDocument()
  })

  it('says that deleting a tenant with projects archives it', async () => {
    let deleted = false
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [tenant({ projectCount: 3 })] })),
      http.delete('/api/tenants/:id', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />)

    await user.click(await screen.findByRole('button', { name: /delete/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Archive tenant' })
    expect(dialog).toHaveTextContent('"Acme" has 3 projects, so it is archived instead of deleted')
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(deleted).toBe(true))
  })

  it('shows archived tenants on request and restores one', async () => {
    let archived = true
    const requests: string[] = []
    let restored = false
    server.use(
      http.get('/api/tenants', ({ request }) => {
        requests.push(new URL(request.url).search)
        const include = new URL(request.url).searchParams.get('includeArchived') === 'true'
        const items = [distributor, ...(include || !archived ? [tenant({ isActive: false, projectCount: 2, archivedAt: archived ? '2026-10-18T11:00:00Z' : undefined })] : [])]
        return HttpResponse.json({ items })
      }),
      http.post('/api/tenants/:id/restore', () => {
        restored = true
        archived = false
        return HttpResponse.json(tenant({ isActive: false }))
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TenantsPage />)

    await screen.findByText('Distributor', { selector: 'td' })
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Show archived'))

    const acme = (await screen.findByText('Acme')).closest('tr')!
    expect(within(acme).getByText('Archived')).toBeInTheDocument()
    // An archived tenant with projects cannot be deleted.
    expect(within(acme).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    await user.click(within(acme).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(restored).toBe(true))
    await waitFor(() => expect(screen.queryByText('Archived')).not.toBeInTheDocument())
    expect(requests).toContain('?includeArchived=true')
  })
})
