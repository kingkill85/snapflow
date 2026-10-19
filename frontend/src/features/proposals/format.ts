import { useTranslation } from 'react-i18next'

import type { BOMTotals } from '@/api/generated/model'
import { useFormatMoney } from '@/features/bom/format'
import { contentLocales } from '@/i18n/content-locales'

/** A proposal's creation time for the UI language, e.g. "19 Oct 2026, 14:05". */
export function useFormatDateTime() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' })
  return (value: string) => format.format(new Date(value))
}

/** The grand total in the project currency as the API computed it (the converted amount, else USD). */
export function useFormatGrandTotal() {
  const money = useFormatMoney()
  return (totals: BOMTotals) => (totals.converted ? money(totals.converted.grandTotal, totals.currency) : money(totals.grandTotal))
}

/** A content language's name ("English", "Deutsch"); an unknown code as it is. */
export function useLanguageName() {
  const { t } = useTranslation()
  return (code: string) => {
    const known = contentLocales.find((l) => l === code)
    return known ? t(`language.${known}`) : code
  }
}

/** Starts the browser download of an API file (the API names it, Content-Disposition). */
export function startDownload(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}
