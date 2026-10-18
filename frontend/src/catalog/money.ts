import { useTranslation } from 'react-i18next'

/** Catalog prices are USD (D19); the API sends them as decimal strings (D52). */
export const catalogCurrency = 'USD'

/** What the API accepts as a price (variant.price_format, D52). */
export const pricePattern = /^\d{1,10}(\.\d{1,2})?$/

/** Formats API prices ("27.50") for the UI language, e.g. "$27.50" or "27,50 $". */
export function useFormatPrice() {
  const { t, i18n } = useTranslation('catalog')
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { style: 'currency', currency: catalogCurrency })
  // Display only: a float is exact enough to show at most 12 digits.
  const price = (value: string) => format.format(Number(value))
  /** One price, or "min – max" when they differ; empty without prices. */
  const range = (min?: string, max?: string) => {
    if (min === undefined || max === undefined) return ''
    return min === max ? price(min) : t('price.range', { min: price(min), max: price(max) })
  }
  return { price, range }
}
