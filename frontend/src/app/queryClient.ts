import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import { getGetMeQueryKey } from '@/api/generated/auth/auth'

export function createQueryClient() {
  const meKey = getGetMeQueryKey()
  // A 401 anywhere means the session ended: re-check it, so the guard sends
  // the user to the login page.
  const onError = (error: Error, queryKey?: readonly unknown[]) => {
    if (!(error instanceof ApiError) || error.status !== 401 || queryKey?.[0] === meKey[0]) return
    void client.invalidateQueries({ queryKey: meKey })
  }
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onError(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => onError(error) }),
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
