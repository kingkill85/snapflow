import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui'

/**
 * Active / Inactive by the item's own flag, or Unavailable when it is active
 * but something above it is not (D54); `unavailableHint` says what.
 */
export function StatusBadge({ available, isActive, unavailableHint }: { available: boolean; isActive: boolean; unavailableHint: string }) {
  const { t } = useTranslation()
  if (available) return <Badge variant="success">{t('status.active')}</Badge>
  if (!isActive) return <Badge>{t('status.inactive')}</Badge>
  return (
    <Badge variant="warning" title={unavailableHint}>
      {t('status.unavailable')}
    </Badge>
  )
}

/** A warning with the number of attribute values that need attention (errors and stale values), nothing without. */
export function ProblemsBadge({ count }: { count: number }) {
  const { t } = useTranslation('products')
  if (count === 0) return null
  return (
    <Badge variant="warning" title={t('problems', { count })}>
      <TriangleAlert aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
    </Badge>
  )
}
