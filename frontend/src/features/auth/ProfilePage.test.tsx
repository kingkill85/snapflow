import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

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
    renderWithProviders(<ProfilePage />, { me: tenantAdminMe })

    expect(screen.getByText('Tenant admin · Acme')).toBeInTheDocument()
    const name = screen.getByLabelText('Full name')
    await user.clear(name)
    await user.type(name, 'Tina Changed')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(posted).toEqual({ fullName: 'Tina Changed', email: tenantAdminMe.email })
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
})
