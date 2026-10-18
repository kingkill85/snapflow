import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import { getGetMeQueryKey } from '@/api/generated/auth/auth'

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Errors of this mutation say nothing about the session, e.g. a failed login. */
      skipSessionCheck?: boolean
    }
  }
}

export function createQueryClient() {
  const meKey = getGetMeQueryKey()
  // A 401 anywhere means the session ended: re-check it, so the guard sends
  // the user to the login page. A 403 means the permissions may have changed:
  // reload them, so pages and buttons follow. The session query's own errors
  // never trigger this, so there is no loop.
  const onError = (error: Error) => {
    if (!(error instanceof ApiError)) return
    if (error.status === 401 || (error.status === 403 && error.code === 'auth.forbidden')) {
      void client.invalidateQueries({ queryKey: meKey })
    }
  }
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] !== meKey[0]) onError(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (!mutation.meta?.skipSessionCheck) onError(error)
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Client errors (4xx) will not fix themselves; only retry the rest.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  })
  return client
}
