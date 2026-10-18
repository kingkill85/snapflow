import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { AppShell } from './AppShell'

const routes = (
  <Routes>
    <Route path="/login" element={<p>login page</p>} />
    <Route path="/" element={<AppShell />}>
      <Route index element={<p>home page</p>} />
    </Route>
  </Routes>
)

describe('AppShell', () => {
  it.each([
    ['succeeds', () => new HttpResponse(null, { status: 204 })],
    ['fails', () => HttpResponse.json({ status: 500, code: 'server.error' }, { status: 500 })],
  ])('signs out, forgets the cache and goes to the login page when the call %s', async (_, respond) => {
    let called = false
    server.use(
      http.post('/api/auth/logout', () => {
        called = true
        return respond()
      }),
    )
    const user = userEvent.setup()
    const { client } = renderWithProviders(routes)

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(called).toBe(true)
    expect(client.getQueryData(getGetMeQueryKey())).toBeUndefined()
  })
})
