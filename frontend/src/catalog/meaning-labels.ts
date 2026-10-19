import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import type { CatalogFieldMeaning } from '@/api/generated/model'
import { type ContentLocale, contentLocales } from '@/i18n/content-locales'

// The one wording of catalog field meanings (D187), in the capabilities
// namespace: the field pages, the category editor and the import all show
// meanings with useMeaningLabel.

/** A meaning's label; empty or missing = "Just information". Unknown meanings show their key. */
export function useMeaningLabel() {
  const { t } = useTranslation('capabilities')
  return (meaning?: string | null): string =>
    meaning ? t(`meaning.${meaning as CatalogFieldMeaning}`, { defaultValue: meaning }) : t('meaning.none')
}

/**
 * The label of a fixed choice a meaning prescribes (motor_type: ac, dc), in
 * every content language that has a UI translation (English otherwise), so a
 * field created with these choices reads "AC motor" / "AC-Motor" everywhere.
 * Unknown keys fall back to the key in upper case.
 */
export function useFixedOptionLabel() {
  const { t, i18n } = useTranslation('capabilities')
  const text = useCallback(
    (key: string): Partial<Record<ContentLocale, string>> =>
      Object.fromEntries(contentLocales.map((l) => [l, i18n.getFixedT(l, 'capabilities')(`fixedOption.${key}` as 'fixedOption.ac', { defaultValue: key.toUpperCase() })])),
    [i18n],
  )
  return {
    /** The label in the UI language. */
    label: (key: string): string => t(`fixedOption.${key}` as 'fixedOption.ac', { defaultValue: key.toUpperCase() }),
    /** The label in every content language (stable). */
    text,
  }
}
