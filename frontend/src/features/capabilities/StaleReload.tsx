import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import { Button } from '@/components/ui'

/**
 * Reload for a save that met a newer version (*.stale): the dialog closes and
 * the list refetches, so the item is edited again from its current version.
 */
export function StaleReload({ error, code, onReload }: { error: unknown; code: string; onReload: () => Promise<void> }) {
  const { t: tCommon } = useTranslation()
  if (!(error instanceof ApiError && error.code === code)) return null
  return (
    <Button size="sm" variant="secondary" onClick={() => void onReload()}>
      <RotateCw /> {tCommon('action.reload')}
    </Button>
  )
}
