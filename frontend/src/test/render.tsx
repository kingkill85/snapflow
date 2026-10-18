import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, MemoryRouter, type RouteObject, RouterProvider } from 'react-router'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import type { Me } from '@/api/generated/model'
import { createQueryClient } from '@/app/queryClient'

import { adminMe } from './fixtures'

type Options = {
  /** The logged-in user; defaults to an admin. null = nobody is logged in yet. */
  me?: Me | null
  /** The initial URL. */
  route?: string
  /** The app's query client (session checks on 401/403, retries) instead of a bare one. */
  appClient?: boolean
  /** Fills the query cache before rendering, e.g. to start from a warm cache. */
  prepare?: (client: QueryClient) => void
}

function setup({ me = adminMe, appClient = false, prepare }: Options) {
  const client = appClient
    ? createQueryClient()
    : new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (me) client.setQueryData(getGetMeQueryKey(), me)
  prepare?.(client)
  return client
}

/** Renders with a fresh query client (no retries), a session and a router. */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const client = setup(options)
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...result, client }
}

/** Like renderWithProviders, but with a data router over the given routes (e.g. the app's). */
export function renderRoutes(routes: RouteObject[], options: Options = {}) {
  const client = setup(options)
  const router = createMemoryRouter(routes, { initialEntries: [options.route ?? '/'] })
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, client, router }
}
