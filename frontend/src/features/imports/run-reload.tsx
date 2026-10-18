import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import { getGetImportQueryKey } from '@/api/generated/imports/imports'
import { Button } from '@/components/ui'

import { invalidateRunDetails } from './paths'

/** The run is no longer in the state the action needs (409 import.state), e.g. applied in another tab. */
export const isStateError = (error: unknown) => error instanceof ApiError && error.code === 'import.state'

/**
 * After 409 import.state the run is fetched again (its page then shows the
 * step of its new state); `action` is a Reload button for the error message.
 */
export function useRunReload(id: string) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const reload = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: getGetImportQueryKey(id) }), invalidateRunDetails(queryClient, id)])
  return {
    /** Call with a failed action's error. */
    check: (error: unknown) => {
      if (isStateError(error)) void reload()
    },
    action: (error: unknown) =>
      isStateError(error) ? (
        <Button size="sm" variant="secondary" onClick={() => void reload()}>
          <RotateCw /> {t('action.reload')}
        </Button>
      ) : undefined,
  }
}

