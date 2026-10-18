import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'

import { useListUsers } from '@/api/generated/users/users'
import { LoginPage } from '@/features/auth'
import { adminMe, tenantAdminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { RequireAuth, RequirePermission } from './guards'

const problem = (status: number, code: string) =>
  HttpResponse.json({ status, code }, { status, headers: { 'Content-Type': 'application/problem+json' } })

function LoginProbe() {
  const location = useLocation()
  return <p>login {location.search}</p>
}

function UsersProbe() {
  const users = useListUsers()
  return <p>{users.isError ? `users failed: ${users.error.code}` : 'users loading'}</p>
}

const routes = (
  <Routes>
    <Route path="/login" element={<LoginProbe />} />
    <Route element={<RequireAuth />}>
      <Route
        path="/admin/users"
        element={
          <RequirePermission permission="users.manage">
            <UsersProbe />
          </RequirePermission>
        }
      />
    </Route>
  </Routes>
)

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('createQueryClient', () => {
  it('re-checks the session after a 401 and sends the user to the login page, once', async () => {
    let meCalls = 0
    server.use(
      http.get('/api/users', () => problem(401, 'auth.required')),
      http.get('/api/auth/me', () => {
        meCalls++
        return problem(401, 'auth.required')
      }),
    )
    renderWithProviders(routes, { route: '/admin/users', appClient: true })

    expect(await screen.findByText(`login ?returnTo=${encodeURIComponent('/admin/users')}`)).toBeInTheDocument()
    await settle()
    expect(meCalls).toBe(1)
  })

  it('reloads the permissions after a 403', async () => {
    let meCalls = 0
    server.use(
      http.get('/api/users', () => problem(403, 'auth.forbidden')),
      http.get('/api/auth/me', () => {
        meCalls++
        // users.manage was taken away in the meantime.
        return HttpResponse.json({ ...tenantAdminMe, permissions: ['catalog.read'] })
      }),
    )
    renderWithProviders(routes, { me: tenantAdminMe, route: '/admin/users', appClient: true })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
    await settle()
    expect(meCalls).toBe(1)
  })

  it('does not re-check the session after a failed login', async () => {
    let meCalls = 0
    server.use(
      http.get('/api/auth/me', () => {
        meCalls++
        return problem(401, 'auth.required')
      }),
      http.post('/api/auth/login', () => problem(401, 'auth.invalid_credentials')),
    )
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      { me: null, route: '/login', appClient: true },
    )

    await user.type(await screen.findByLabelText('Email'), adminMe.email)
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Email or password is wrong.')).toBeInTheDocument()
    await settle()
    expect(meCalls).toBe(1) // the initial check only
  })

  it('ignores errors of the session query itself', async () => {
    let meCalls = 0
    server.use(
      http.get('/api/auth/me', () => {
        meCalls++
        return problem(403, 'auth.forbidden')
      }),
    )
    renderWithProviders(routes, { me: null, route: '/admin/users', appClient: true })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this.'))
    await settle()
    expect(meCalls).toBe(1)
  })
})
