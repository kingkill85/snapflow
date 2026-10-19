import { useTranslation } from 'react-i18next'

import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { type LocalizedText, useLocalized } from '@/i18n/localized'

/** What a need line shows: the parts of "3 × Dimmable light · 60 W · LED · Ceiling". */
export type NeedLineParts = {
  quantity: number
  functionTypeName: LocalizedText | undefined
  /** Per unit; null for unknown. */
  powerW: number | null
  loadTypeName?: LocalizedText | null
  label: string
}

/** A number of watts with the UI language's decimal separator (D144). */
export function useFormatWatts() {
  const separator = useDecimalSeparator()
  return (watts: number) => formatDecimal(String(watts), separator)
}

/**
 * A need in plain words: "3 × Dimmable light · 60 W · LED · Ceiling" (parts
 * left out when empty). Used by the needs overview and the editor's needs rows.
 */
export function useNeedText() {
  const { t } = useTranslation('needs')
  const localize = useLocalized()
  const watts = useFormatWatts()
  return (n: NeedLineParts) =>
    [
      `${t('line.quantity', { count: n.quantity })} ${localize(n.functionTypeName)}`,
      n.powerW != null ? t('line.power', { power: watts(n.powerW) }) : '',
      n.loadTypeName ? localize(n.loadTypeName) : '',
      n.label.trim(),
    ]
      .filter(Boolean)
      .join(' · ')
}

/** Totals in words: "7 units · 420 W" (the power only when there is one). */
export function useNeedTotalsText() {
  const { t } = useTranslation('needs')
  const watts = useFormatWatts()
  return (totals: { quantity: number; powerW: number }) =>
    totals.powerW > 0
      ? t('totalsPower', { count: totals.quantity, power: watts(totals.powerW) })
      : t('totals', { count: totals.quantity })
}
