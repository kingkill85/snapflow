import { useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import { getGetMeQueryKey, useGetMe } from '@/api/generated/auth/auth'
import type { Me, Permission } from '@/api/generated/model'

// The logged-in user lives in the query cache under the getMe key. It only
// changes on login, logout and profile edits, which update it explicitly.
const meOptions = { query: { retry: false, staleTime: Infinity } } as const

/** The session state, for the guards. */
export function useSession() {
  const me = useGetMe(meOptions)
  const anonymous = me.error instanceof ApiError && me.error.status === 401
  return { me: anonymous ? undefined : me.data, isPending: me.isPending, anonymous, error: anonymous ? null : me.error }
}

/** The logged-in user. Only use below RequireAuth, where it is loaded. */
export function useMe(): Me {
  const { data } = useGetMe(meOptions)
  if (!data) throw new Error('useMe used outside RequireAuth')
  return data
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
