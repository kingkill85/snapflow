import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'

import { adminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { LoginPage } from './LoginPage'
import { safeReturnTo } from './return-to'

const problem = (status: number, code: string, params?: object) =>
  HttpResponse.json({ status, code, params }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const routes = (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/admin/users" element={<p>users page</p>} />
  </Routes>
)

describe('LoginPage', () => {
  it('logs in and returns to the requested page', async () => {
    let posted: unknown
    server.use(
      http.get('/api/auth/me', () => problem(401, 'auth.required')),
      http.post('/api/auth/login', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(adminMe)
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { me: null, route: '/login?returnTo=%2Fadmin%2Fusers' })

    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'secret-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('users page')).toBeInTheDocument()
    expect(posted).toEqual({ email: 'admin@example.com', password: 'secret-password' })
  })

  it('translates login errors', async () => {
    server.use(
      http.get('/api/auth/me', () => problem(401, 'auth.required')),
      http.post('/api/auth/login', () => problem(429, 'auth.too_many_attempts', { seconds: 42 })),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { me: null, route: '/login' })

    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!
    expect(await within(form).findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 42 seconds.')
  })

  it('sends a user who is already logged in to the requested page', async () => {
    renderWithProviders(routes, { me: adminMe, route: '/login?returnTo=%2Fadmin%2Fusers' })

    expect(await screen.findByText('users page')).toBeInTheDocument()
  })

  it('shows field errors from the API at the field', async () => {
    server.use(
      http.get('/api/auth/me', () => problem(401, 'auth.required')),
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          { status: 422, code: 'validation.failed', fields: [{ location: 'body.email', code: 'validation.invalid' }] },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(routes, { me: null, route: '/login' })

    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'secret-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('This value is invalid.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('This value is invalid.')
    expect(screen.getByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
  })

  it('only returns to paths inside the app', () => {
    expect(safeReturnTo('/admin/users?x=1')).toBe('/admin/users?x=1')
    expect(safeReturnTo('https://evil.example')).toBe('/')
    expect(safeReturnTo('//evil.example')).toBe('/')
    expect(safeReturnTo('/\\evil.example')).toBe('/')
    expect(safeReturnTo(null)).toBe('/')
  })
})
