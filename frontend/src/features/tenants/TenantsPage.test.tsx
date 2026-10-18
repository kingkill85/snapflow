import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Tenant } from '@/api/generated/model'
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
})
