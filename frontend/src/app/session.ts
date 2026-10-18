import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError } from '@/api/client'
import { getGetMeQueryKey, useGetMe } from '@/api/generated/auth/auth'
import type { Me, Permission } from '@/api/generated/model'

// The logged-in user lives in the query cache under the getMe key. Login,
// logout and profile edits update it explicitly; it is reloaded when it is
// older than five minutes and the window regains focus, and after a 401 or
// 403 anywhere (see createQueryClient), so changed permissions apply.
const meOptions = { query: { retry: false, staleTime: 5 * 60_000 } } as const

/** The session state, for the guards. */
export function useSession() {
  const me = useGetMe(meOptions)
  const anonymous = me.error instanceof ApiError && me.error.status === 401
  return { me: anonymous ? undefined : me.data, isPending: me.isPending, anonymous, error: anonymous ? null : me.error }
}

/** The logged-in user. Only use below RequireAuth, where it is loaded. */
export function useMe(): Me {
  const { data } = useGetMe(meOptions)
  // Signing out clears the cache while the page is still mounted; keep the
  // last known user until the navigation to /login unmounts it.
  const [last, setLast] = useState(data)
  if (data && data !== last) setLast(data)
  const me = data ?? last
  if (!me) throw new Error('useMe used outside RequireAuth')
  return me
}

/** Checks the user's permissions, as listed by the API. */
export function useCan() {
  const me = useMe()
  return (permission: Permission) => me.permissions.includes(permission)
}

/** Replaces the cached session, e.g. after login or a profile change. */
export function useSetMe() {
  const queryClient = useQueryClient()
  return (me: Me) => queryClient.setQueryData(getGetMeQueryKey(), me)
}
