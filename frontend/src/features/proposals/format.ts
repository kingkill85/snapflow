import { useTranslation } from 'react-i18next'

import type { BOMTotals } from '@/api/generated/model'
import { useFormatMoney } from '@/features/bom/format'

/** A proposal's creation time for the UI language, e.g. "19 Oct 2026, 14:05". */
export function useFormatDateTime() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' })
  return (value: string) => format.format(new Date(value))
}

/** The grand total in the project currency as the API computed it (the converted amount, else USD). */
export function useFormatGrandTotal() {
  const amount = useFormatAmount()
  return (totals: BOMTotals) => amount(totals.grandTotal, totals.converted?.grandTotal ?? null, totals.currency)
}

/** An amount in the project currency as the API computed it: the converted amount in `currency`, else the USD amount. */
export function useFormatAmount() {
  const money = useFormatMoney()
  return (usd: string, converted: string | null, currency: string) => (converted !== null ? money(converted, currency) : money(usd))
}

/** A document language's name in the UI language ("English", or "Englisch" in a German UI); an unknown code in capitals. */
export function useLanguageName() {
  const { i18n } = useTranslation()
  const uiLanguage = i18n.resolvedLanguage ?? 'en'
  return (code: string) => {
    try {
      const name = new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(code) ?? code
      return name.charAt(0).toLocaleUpperCase(uiLanguage) + name.slice(1)
    } catch {
      return code.toUpperCase()
    }
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

/** The gap between downloads of several files: browsers block or drop downloads started all at once. */
export const downloadGap = 300

/** Starts the downloads of several API files one after another, `downloadGap` ms apart. */
export function startDownloads(urls: string[]) {
  urls.forEach((url, i) => {
    if (i === 0) startDownload(url)
    else setTimeout(() => startDownload(url), i * downloadGap)
  })
}
