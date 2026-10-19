import { useQueryClient } from '@tanstack/react-query'

import { getGetNetworksQueryKey, getListBusLinesQueryKey } from '@/api/generated/networks/networks'

/** Reloads the networks view (and the line list) after a change. */
export function useRefreshNetworks(versionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetNetworksQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListBusLinesQueryKey(versionId) }),
    ])
}
