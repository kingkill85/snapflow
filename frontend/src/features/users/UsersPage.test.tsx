import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Tenant, User } from '@/api/generated/model'
import { adminMe, tenantAdminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'
import { chooseOption, optionTexts } from '@/test/select'

import { UsersPage } from './UsersPage'

const acme: Tenant = {
  id: tenantAdminMe.tenantId,
  name: 'Acme',
  isDistributor: false,
  isActive: true,
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  projectCount: 0,
  can: { update: true, delete: true },
}

const beta: Tenant = { ...acme, id: '00000000-0000-4000-8000-0000000000b2', name: 'Beta' }

const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

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
    expect(await optionTexts(u, role)).toEqual(['Tenant admin', 'User'])

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
    expect(within(dialog).queryByLabelText('Password')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Open profile' })).toHaveAttribute('href', '/profile')
  })

  it('filters by tenant and preselects that tenant for new users', async () => {
    const requested: string[] = []
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [acme, beta] })),
      http.get('/api/users', ({ request }) => {
        requested.push(new URL(request.url).search)
        return HttpResponse.json({ items: [] })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: adminMe })

    const filter = await screen.findByRole('combobox', { name: 'Tenant' })
    await chooseOption(u, filter, 'Beta')

    await waitFor(() => expect(requested).toContain(`?tenantId=${beta.id}`))
    await u.click((await screen.findAllByRole('button', { name: /new user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Tenant')).toHaveTextContent('Beta')
  })

  it('keeps the password when it is left empty on edit', async () => {
    let put: unknown
    server.use(
      http.get('/api/users', () => HttpResponse.json({ items: [user({})] })),
      http.put('/api/users/:id', async ({ request }) => {
        put = await request.json()
        return HttpResponse.json(user({ fullName: 'Uwe Changed' }))
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    await u.click(await screen.findByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Full name')
    await u.clear(name)
    await u.type(name, 'Uwe Changed')
    await u.click(within(dialog).getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(put).toEqual({ email: 'uwe@acme.example', fullName: 'Uwe Changed', role: 'user', tenantId: acme.id, isActive: true })
  })

  it('shows API field errors at the field', async () => {
    server.use(
      http.get('/api/tenants', () => HttpResponse.json({ items: [acme] })),
      http.get('/api/users', () => HttpResponse.json({ items: [] })),
      http.post('/api/users', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'body.tenantId', code: 'user.tenant_not_found' }] }),
      ),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: adminMe })

    // The tenants have loaded.
    await u.click(await screen.findByRole('combobox', { name: 'Tenant' }))
    await screen.findByRole('option', { name: 'Acme' })
    await u.keyboard('{Escape}')
    await u.click((await screen.findAllByRole('button', { name: /new user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    await u.type(within(dialog).getByLabelText('Email'), 'new@acme.example')
    await u.type(within(dialog).getByLabelText('Password'), 'a-long-password')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByText('The selected tenant does not exist.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Tenant')).toHaveAccessibleDescription('The selected tenant does not exist.')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
  })

  it('deletes a user, showing errors in the confirm dialog and starting fresh for the next one', async () => {
    const other = user({ id: '00000000-0000-4000-8000-000000000103', email: 'otto@acme.example', fullName: 'Otto' })
    let items = [user({}), other]
    server.use(
      http.get('/api/users', () => HttpResponse.json({ items })),
      http.delete('/api/users/:id', ({ params }) => {
        if (params.id === other.id) return problem(409, { code: 'user.last_admin' })
        items = items.filter((i) => i.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    const otto = (await screen.findByText('otto@acme.example')).closest('tr')!
    await u.click(within(otto).getByRole('button', { name: /delete/i }))
    let dialog = await screen.findByRole('dialog')
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('At least one active admin must remain.')
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const uwe = screen.getByText('uwe@acme.example').closest('tr')!
    await u.click(within(uwe).getByRole('button', { name: /delete/i }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByText('uwe@acme.example')).not.toBeInTheDocument())
    expect(screen.getByText('otto@acme.example')).toBeInTheDocument()
  })

  it('shows no tenant column or filter to a tenant admin', async () => {
    server.use(http.get('/api/users', () => HttpResponse.json({ items: [user({})] })))
    renderWithProviders(<UsersPage />, { me: tenantAdminMe })

    expect(await screen.findByText('uwe@acme.example')).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Tenant' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Tenant' })).not.toBeInTheDocument()
  })

  it('shows when the tenant list fails', async () => {
    server.use(
      http.get('/api/tenants', () => problem(500, { code: 'server.error' })),
      http.get('/api/users', () => HttpResponse.json({ items: [] })),
    )
    renderWithProviders(<UsersPage />, { me: adminMe })

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.')
  })
})
