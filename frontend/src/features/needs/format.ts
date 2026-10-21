import { useTranslation } from 'react-i18next'

import { formatDecimal, parseDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { type LocalizedText, useLocalized } from '@/i18n/localized'

/** The highest power per unit in W the API accepts (need.power_invalid). */
export const maxPowerW = 100000

/**
 * A typed power per unit ("7,5", "7.5", "60") as the API takes it, in the
 * API's own form with exactly 2 decimals ("7.50"): null for an empty field
 * (unknown), undefined for text that is not 0 to 100000 with at most 2
 * decimals (the backend's rule, need.power_invalid). Never rounded: a third
 * decimal is refused like the backend refuses it.
 */
export function parsePower(text: string): string | null | undefined {
  if (text.trim() === '') return null
  const point = parseDecimal(text)
  if (point === undefined || point.startsWith('-')) return undefined
  const [whole, fraction = ''] = point.split('.')
  if (fraction.length > 2) return undefined
  const value = `${Number(whole)}.${fraction.padEnd(2, '0')}`
  return Number(value) <= maxPowerW ? value : undefined
}

/**
 * Watts as the API sends them ("7.50", "60.00") without trailing zeros and
 * with the UI language's decimal separator ("7,5", "60"; D144): the one
 * number format of power in need lines, totals and the power fields.
 */
export function formatWatts(watts: string, separator: ',' | '.'): string {
  const trimmed = watts.includes('.') ? watts.replace(/0+$/, '').replace(/\.$/, '') : watts
  return formatDecimal(trimmed, separator)
}

/** True when a total has power ("0.00" has none). */
export const hasPower = (watts: string) => Number(watts) !== 0

/** `formatWatts` with the UI language's separator. */
export function useFormatWatts() {
  const separator = useDecimalSeparator()
  return (watts: string) => formatWatts(watts, separator)
}

/** What a need line shows: the parts of "3 × Dimmable light · 7.5 W · LED · Ceiling". */
export type NeedLineParts = {
  quantity: number
  /** undefined: unknown (deleted) function type. */
  functionTypeName: LocalizedText | undefined
  /** Per unit as the API sends it ("7.50"); null for unknown. */
  powerW: string | null
  loadTypeName?: LocalizedText | null
  label: string
}

/**
 * A need in plain words: "3 × Dimmable light · 7.5 W · LED · Ceiling", the
 * quantity always shown ("1 × Blind"), power, load type and label only when
 * set. The one need text of the editor's rows, the symbol inspector, the
 * save-error list and the needs overview.
 */
export function useNeedText() {
  const { t } = useTranslation('needs')
  const localize = useLocalized()
  const watts = useFormatWatts()
  return (n: NeedLineParts) =>
    [
      t('line.quantity', { count: n.quantity, name: n.functionTypeName ? localize(n.functionTypeName) : t('line.unknown') }),
      n.powerW != null ? t('line.power', { power: watts(n.powerW) }) : '',
      n.loadTypeName ? localize(n.loadTypeName) : '',
      n.label.trim(),
    ]
      .filter(Boolean)
      .join(' · ')
}
