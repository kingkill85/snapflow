import { useTranslation } from 'react-i18next'

import type { CatalogFieldMeaning } from '@/api/generated/model'

// The one wording of catalog field meanings (D187), in the capabilities
// namespace: the field pages, the category editor and the import all show
// meanings with useMeaningLabel.

/** A meaning's label; empty or missing = "Just information". Unknown meanings show their key. */
export function useMeaningLabel() {
  const { t } = useTranslation('capabilities')
  return (meaning?: string | null): string =>
    meaning ? t(`meaning.${meaning as CatalogFieldMeaning}`, { defaultValue: meaning }) : t('meaning.none')
}
