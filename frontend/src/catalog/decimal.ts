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
