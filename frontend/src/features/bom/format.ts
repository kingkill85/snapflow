import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { getGetBomQueryKey, getGetCatalogChangesQueryKey, getGetPricingQueryKey, getListManualLinesQueryKey } from '@/api/generated/bom/bom'
import type { NullableItemSnapshot } from '@/api/generated/model'
import { useLocalized } from '@/i18n/localized'

/** Catalog prices and every BOM amount are USD (D19); converted amounts are in the project currency. */
export const usd = 'USD'

/**
 * How an amount's sign is shown: `auto` as it is, `signed` with "+" or "−"
 * (a change), `negated` as a deduction (the discount, sent positive).
 */
export type MoneySign = 'auto' | 'signed' | 'negated'

/**
 * Formats an API amount (decimal string) for the UI language, e.g. "$1,234.50"
 * or "1.234,50 €". Display only: the API has done every calculation (rule 1);
 * the decimal string goes to Intl as it is, so every digit is exact. Negative
 * amounts get a real minus sign (U+2212, as wide as "+" and the digits) instead
 * of Intl's hyphen, which looks detached in tabular figures.
 */
export function useFormatMoney() {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? 'en'
  return (value: string, currency: string = usd, sign: MoneySign = 'auto') => {
    const format = new Intl.NumberFormat(language, { style: 'currency', currency, signDisplay: sign === 'auto' ? 'auto' : 'exceptZero' })
    const v = sign === 'negated' ? (value.startsWith('-') ? value.slice(1) : `-${value}`) : value
    return format
      .formatToParts(v as Intl.StringNumericLiteral)
      .map((p) => (p.type === 'minusSign' ? '\u2212' : p.value))
      .join('')
  }
}

/** The rate as the API sends it, with the UI language's digits (e.g. "0,92"). */
export function useFormatRate() {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 10 })
  return (value: string) => format.format(value as Intl.StringNumericLiteral)
}

/** The display name of a BOM line or manual line: free text, or product (and variant). */
export function useLineName() {
  const localize = useLocalized()
  return (line: { name: string; snapshot: NullableItemSnapshot | null }) => {
    if (!line.snapshot) return line.name
    const variant = localize(line.snapshot.variantName)
    const product = localize(line.snapshot.productName)
    return variant ? `${product} – ${variant}` : product
  }
}

/** Everything the BOM shows, refetched after a change. */
export function useRefreshBom(versionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetBomQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListManualLinesQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetCatalogChangesQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetPricingQueryKey(versionId) }),
    ])
}

/** Data loaded on every visit and not refreshed underneath a form (D44). */
export const fresh = { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const
