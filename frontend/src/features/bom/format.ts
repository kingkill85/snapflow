import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { getGetBomQueryKey, getGetCatalogChangesQueryKey, getGetPricingQueryKey, getListManualLinesQueryKey } from '@/api/generated/bom/bom'
import type { BOMAmounts, BOMLine, BOMTotals, Bom, CatalogChange, ConvertedLine, ItemSnapshot, LineStatus, ManualLine } from '@/api/generated/model'
import { useLocalized } from '@/i18n/localized'

/** Catalog prices and every BOM amount are USD (D19); converted amounts are in the project currency. */
export const usd = 'USD'

/**
 * Formats an API amount (decimal string) for the UI language, e.g. "$1,234.50"
 * or "1.234,50 €". Display only: the API has done every calculation (rule 1),
 * and a float is exact enough to show its digits.
 */
export function useFormatMoney() {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? 'en'
  return (value: string, currency: string = usd, signed = false) =>
    new Intl.NumberFormat(language, { style: 'currency', currency, signDisplay: signed ? 'exceptZero' : 'auto' }).format(Number(value))
}

/** The rate as the API sends it, with the UI language's digits (e.g. "0,92"). */
export function useFormatRate() {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 10 })
  return (value: string) => format.format(Number(value))
}

/** The display name of a BOM line or manual line: free text, or product (and variant). */
export function useLineName() {
  const localize = useLocalized()
  return (line: { name: string; snapshot: ItemSnapshot | null }) => {
    if (!line.snapshot) return line.name
    const variant = localize(line.snapshot.variantName)
    const product = localize(line.snapshot.productName)
    return variant ? `${product} – ${variant}` : product
  }
}

// The API sends null for these object fields; huma cannot mark object fields
// nullable in the OpenAPI document, so the generated types do not say so.
export type BomLine = Omit<BOMLine, 'snapshot' | 'status' | 'converted'> & { snapshot: ItemSnapshot | null; status: LineStatus | null; converted: ConvertedLine | null }
export type BomManualLine = Omit<ManualLine, 'snapshot'> & { snapshot: ItemSnapshot | null }
export type BomTotals = Omit<BOMTotals, 'converted'> & { converted: BOMAmounts | null }
export type BomData = Omit<Bom, 'lines' | 'manualLines' | 'totals'> & { lines: BomLine[]; manualLines: BomManualLine[]; totals: BomTotals }
export type Change = Omit<CatalogChange, 'after'> & { after: CatalogChange['before'] | null }

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
