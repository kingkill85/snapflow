import { useQueryClient } from '@tanstack/react-query'

import { getGetNetworksQueryKey, getListBusLinesQueryKey } from '@/api/generated/networks/networks'
import { getGetChecksQueryKey } from '@/api/generated/wiring/wiring'

/** Reloads the networks view (the line list and the checks with their statuses) after a change. */
export function useRefreshNetworks(versionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetNetworksQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListBusLinesQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetChecksQueryKey(versionId) }),
    ])
}
