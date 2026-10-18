import { useTranslation } from 'react-i18next'

// Decimal numbers as people type them: "27.50" or "27,50" (D71). Shared by
// prices, number attributes and attribute bounds, so every number input
// accepts the same text.

/**
 * Digits with at most one "." or "," as the decimal separator, an optional
 * leading minus; no thousands separators, exponents, hex or binary forms
 * (which Number() would accept).
 */
const decimalPattern = /^-?(\d+([.,]\d+)?|[.,]\d+)$/

/**
 * The point form of a decimal typed with "." or "," ("27,5" → "27.5",
 * ",5" → "0.5"), or undefined for text that is not such a number. Surrounding
 * blanks are ignored.
 */
export function parseDecimal(text: string): string | undefined {
  const v = text.trim()
  if (!decimalPattern.test(v)) return undefined
  const point = v.replace(',', '.')
  return point.replace(/^(-?)\./, '$10.')
}

/** The decimal separator a language writes ("," in German, "." in English). */
export function decimalSeparator(language: string): ',' | '.' {
  const part = new Intl.NumberFormat(language).formatToParts(1.5).find((p) => p.type === 'decimal')
  return part?.value === ',' ? ',' : '.'
}

/** The decimal separator of the UI language, for showing numbers in inputs. */
export function useDecimalSeparator() {
  const { i18n } = useTranslation()
  return decimalSeparator(i18n.resolvedLanguage ?? 'en')
}

/**
 * A number or its point form ("27.50") as an input shows it in a language
 * with `separator` ("27,50"): only the separator changes (no grouping,
 * digits as stored), so `parseDecimal` gives the same value back (D71).
 * Other text is returned unchanged.
 */
export function formatDecimal(value: number | string, separator: ',' | '.'): string {
  const text = typeof value === 'number' ? String(value) : value
  return separator === ',' && /^-?\d*\.\d+$/.test(text) ? text.replace('.', ',') : text
}
