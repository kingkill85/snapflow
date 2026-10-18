import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import { getListUsersQueryKey } from '@/api/generated/users/users'

import { tenantAdminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProfilePage } from './ProfilePage'

describe('ProfilePage', () => {
  it('shows role and tenant and saves the details', async () => {
    let posted: unknown
    server.use(
      http.put('/api/auth/me', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ ...tenantAdminMe, fullName: 'Tina Changed' })
      }),
    )
    const user = userEvent.setup()
    const { client } = renderWithProviders(<ProfilePage />, { me: tenantAdminMe })
    client.setQueryData(getListUsersQueryKey(), { items: [] })

    expect(screen.getByText('Tenant admin · Acme')).toBeInTheDocument()
    const name = screen.getByLabelText('Full name')
    await user.clear(name)
    await user.type(name, 'Tina Changed')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(posted).toEqual({ fullName: 'Tina Changed', email: tenantAdminMe.email })
    expect(client.getQueryData<{ fullName: string }>(getGetMeQueryKey())?.fullName).toBe('Tina Changed')
    await waitFor(() => expect(client.getQueryState(getListUsersQueryKey())?.isInvalidated).toBe(true))
  })

  it('checks the new password before sending it', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    await user.type(screen.getByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Repeat new password'), 'other-password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument()
  })

  it('changes the password', async () => {
    let posted: unknown
    server.use(
      http.put('/api/auth/me/password', async ({ request }) => {
        posted = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    await user.type(screen.getByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Repeat new password'), 'new-password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('Password changed.')).toBeInTheDocument()
    expect(posted).toEqual({ currentPassword: 'old-password', newPassword: 'new-password' })
  })

  it('shows the wrong current password at its field', async () => {
    server.use(
      http.put('/api/auth/me/password', () =>
        HttpResponse.json(
          { status: 422, code: 'validation.failed', fields: [{ location: 'body.currentPassword', code: 'auth.wrong_password' }] },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    await user.type(screen.getByLabelText('Current password'), 'wrong-password')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Repeat new password'), 'new-password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('The current password is wrong.')).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toHaveAccessibleDescription('The current password is wrong.')
  })

  it('translates a rate limit on the password change', async () => {
    server.use(
      http.put('/api/auth/me/password', () =>
        HttpResponse.json(
          { status: 429, code: 'auth.too_many_attempts', params: { seconds: 30 } },
          { status: 429, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    await user.type(screen.getByLabelText('Current password'), 'old-password')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Repeat new password'), 'new-password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 30 seconds.')
  })

  it('signs out everywhere after confirming', async () => {
    let called = false
    server.use(
      http.post('/api/auth/logout-all', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    const { client } = renderWithProviders(
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>,
      { me: tenantAdminMe, route: '/profile' },
    )

    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog')
    expect(called).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(called).toBe(true)
    expect(client.getQueryData(getGetMeQueryKey())).toBeUndefined()
  })

  it('stays and shows the error when signing out everywhere fails', async () => {
    server.use(http.post('/api/auth/logout-all', () => HttpResponse.json({ status: 503, code: 'server.busy' }, { status: 503 })))
    const user = userEvent.setup()
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The server is busy. Please try again in a moment.')
  })
})
