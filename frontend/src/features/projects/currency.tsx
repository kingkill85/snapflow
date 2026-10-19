import { useTranslation } from 'react-i18next'

import { useListCurrencies } from '@/api/generated/projects/projects'
import type { ComboboxOption } from '@/components/ui'

import { fresh } from './paths'

/** "EUR – Euro" in the UI language (Intl.DisplayNames); the code alone where the browser has no name. */
export function currencyLabel(code: string, language: string) {
  try {
    const name = new Intl.DisplayNames([language], { type: 'currency' }).of(code)
    return name && name !== code ? `${code} – ${name}` : code
  } catch {
    return code
  }
}

/**
 * The currencies a project may use (GET /api/currencies) as combobox options:
 * USD first, then the tenant's recently used ones, then the rest by code.
 * `current` stays choosable even if the list no longer has it; the recent
 * ones are `tenantId`'s (the project's, or the tenant chosen for it).
 * `noOnlineRate(code)` is true only when the server knows the provider has
 * no rate for it.
 */
export function useCurrencyOptions(enabled: boolean, current?: string, tenantId?: string) {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? 'en'
  const query = useListCurrencies(tenantId ? { tenantId } : undefined, { query: { ...fresh, enabled } })
  const items = query.data?.items ?? []
  const recent = query.data?.recent ?? []
  const codes = items.map((c) => c.code)
  if (current && !codes.includes(current)) codes.push(current)
  const rank = (code: string) => (code === 'USD' ? -1 : recent.includes(code) ? recent.indexOf(code) : recent.length)
  const ordered = [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const options: ComboboxOption[] = ordered.map((code) => ({ value: code, label: currencyLabel(code, language), keywords: code }))
  const noOnlineRate = (code: string) => !!query.data?.onlineKnown && items.some((c) => c.code === code && !c.online)
  return { options, noOnlineRate, error: query.error, isLoading: query.isLoading }
}

/** A rate's date as a day in the UI language ("19.10.2026", "10/19/2026"). */
export function useFormatRateDate() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return (iso: string) => format.format(new Date(iso))
}
