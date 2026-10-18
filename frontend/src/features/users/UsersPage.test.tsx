import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Tenant, User } from '@/api/generated/model'
import { adminMe, tenantAdminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { UsersPage } from './UsersPage'

const acme: Tenant = {
  id: tenantAdminMe.tenantId,
  name: 'Acme',
  isDistributor: false,
  isActive: true,
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  can: { update: true, delete: true },
}

const user = (over: Partial<User>): User => ({
  id: '00000000-0000-4000-8000-000000000101',
  tenantId: acme.id,
  email: 'uwe@acme.example',
  fullName: 'Uwe User',
  role: 'user',
  isActive: true,
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  can: { update: true, delete: true },
  ...over,
})

describe('UsersPage', () => {
  it('lists users with tenant, role and status, offering only allowed actions', async () => {
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [acme] })),
      http.get('/api/users', () =>
        HttpResponse.json({
          items: [
            user({}),
            user({
              id: '00000000-0000-4000-8000-000000000102',
              email: 'boss@example.com',
              fullName: 'Boss',
              role: 'admin',
              isActive: false,
              can: { update: false, delete: false },
            }),
          ],
        }),
      ),
    )
    renderWithProviders(<UsersPage />, { me: adminMe })

    const uwe = (await screen.findByText('uwe@acme.example')).closest('tr')!
    expect(within(uwe).getByText('User')).toBeInTheDocument()
    expect(await within(uwe).findByText('Acme')).toBeInTheDocument()
    expect(within(uwe).getByRole('button', { name: /edit/i })).toBeInTheDocument()

    const boss = screen.getByText('boss@example.com').closest('tr')!
    expect(within(boss).getByText('Inactive')).toBeInTheDocument()
    expect(within(boss).queryByRole('button')).not.toBeInTheDocument()
  })

  it('lets a tenant admin create users in their own tenant with the roles they may assign', async () => {
    let items: User[] = []
    let posted: unknown
    server.use(
      http.get('/api/users', () => HttpResponse.json({ items })),
      http.post('/api/users', async ({ request }) => {
        posted = await request.json()
        items = [user({ email: 'new@acme.example' })]
        return HttpResponse.json(items[0], { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    await u.click((await screen.findAllByRole('button', { name: /new user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('Tenant')).not.toBeInTheDocument()
    const role = within(dialog).getByLabelText('Role')
    expect(within(role).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tenant admin', 'User'])

    await u.type(within(dialog).getByLabelText('Email'), 'new@acme.example')
    await u.type(within(dialog).getByLabelText('Password'), 'a-long-password')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posted).toEqual({
      email: 'new@acme.example',
      fullName: '',
      role: 'user',
      tenantId: tenantAdminMe.tenantId,
      isActive: true,
      password: 'a-long-password',
    })
    expect(await screen.findByText('new@acme.example')).toBeInTheDocument()
  })

  it('requires a password for new users', async () => {
    server.use(http.get('/api/users', () => HttpResponse.json({ items: [] })))
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    await u.click((await screen.findAllByRole('button', { name: /new user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await u.type(within(dialog).getByLabelText('Email'), 'new@acme.example')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument()
  })

  it('translates API errors', async () => {
    server.use(
      http.get('/api/users', () => HttpResponse.json({ items: [] })),
      http.post('/api/users', () =>
        HttpResponse.json(
          { status: 409, code: 'user.email_taken', params: { email: 'new@acme.example' } },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    await u.click((await screen.findAllByRole('button', { name: /new user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await u.type(within(dialog).getByLabelText('Email'), 'new@acme.example')
    await u.type(within(dialog).getByLabelText('Password'), 'a-long-password')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The email address new@acme.example is already used.')
  })

  it('hides role, tenant and status when editing yourself', async () => {
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [acme] })),
      http.get('/api/users', () => HttpResponse.json({ items: [user({ id: adminMe.id, email: adminMe.email, role: 'admin' })] })),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: adminMe })

    await u.click(await screen.findByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('Role')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Tenant')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Active')).not.toBeInTheDocument()
  })
})
