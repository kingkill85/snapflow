import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { Me } from '@/api/generated/model'
import { adminMe, tenantAdminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { features } from './features'
import { Home, RequireAuth, RequirePermission } from './guards'

function PathProbe() {
  const location = useLocation()
  return <p>landed on {location.pathname}</p>
}

function LoginProbe() {
  const location = useLocation()
  return <p>login {location.search}</p>
}

const routes = (
  <Routes>
    <Route path="/login" element={<LoginProbe />} />
    <Route element={<RequireAuth />}>
      <Route
        path="/admin/users"
        element={
          <RequirePermission permission="users.manage">
            <p>users page</p>
          </RequirePermission>
        }
      />
      <Route path="/catalog" element={<p>catalog page</p>} />
    </Route>
  </Routes>
)

const unauthorized = () =>
  HttpResponse.json({ status: 401, code: 'auth.required' }, { status: 401, headers: { 'Content-Type': 'application/problem+json' } })

describe('guards', () => {
  it('sends anonymous users to the login page with a return path', async () => {
    server.use(http.get('/api/auth/me', unauthorized))
    renderWithProviders(routes, { me: null, route: '/catalog?x=1' })

    expect(await screen.findByText(`login ?returnTo=${encodeURIComponent('/catalog?x=1')}`)).toBeInTheDocument()
  })

  it('renders protected pages for a logged-in user', async () => {
    renderWithProviders(routes, { me: userMe, route: '/catalog' })

    expect(await screen.findByText('catalog page')).toBeInTheDocument()
  })

  it('shows a notice instead of a page the user may not see', async () => {
    renderWithProviders(routes, { me: userMe, route: '/admin/users' })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
    expect(screen.queryByText('users page')).not.toBeInTheDocument()
  })

  it('sends a user to the function types', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<PathProbe />} />
      </Routes>,
      { me: userMe },
    )

    expect(await screen.findByText('landed on /catalog/function-types')).toBeInTheDocument()
  })

  it.each([
    ['admin', adminMe],
    ['tenant admin', tenantAdminMe],
    ['user', userMe],
  ] as [string, Me][])('sends a %s to a page they may see', async (_, me) => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<PathProbe />} />
      </Routes>,
      { me },
    )

    const text = (await screen.findByText(/^landed on /)).textContent!
    const feature = features.find((f) => text === `landed on /${f.path}`)
    expect(feature).toBeDefined()
    expect(!feature!.permission || me.permissions.includes(feature!.permission)).toBe(true)
  })
})
