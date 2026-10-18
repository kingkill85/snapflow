import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import type { Me } from '@/api/generated/model'

import { adminMe } from './fixtures'

type Options = {
  /** The logged-in user; defaults to an admin. null = nobody is logged in yet. */
  me?: Me | null
  /** The initial URL. */
  route?: string
}

/** Renders with a fresh query client (no retries), a session and a router. */
export function renderWithProviders(ui: ReactElement, { me = adminMe, route = '/' }: Options = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (me) client.setQueryData(getGetMeQueryKey(), me)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}
