import { useTranslation } from 'react-i18next'

import type { MissingCode, ReadinessItemCode } from '@/api/generated/model'

// The one wording of the catalog readiness codes (D446, D447): the Systems
// page's Readiness section and the product page's "Still missing" lines.

/** An item's one-liner (its count is shown next to it). */
export function useReadinessText() {
  const { t } = useTranslation('catalog')
  return (code: ReadinessItemCode): string => t(`readiness.code.${code}`)
}

/** A product's "Still missing" line in plain words. */
export function useMissingText() {
  const { t } = useTranslation('catalog')
  return (code: MissingCode): string => t(`readiness.missing.${code}`)
}
