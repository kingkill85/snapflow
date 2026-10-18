import { useTranslation } from 'react-i18next'

/** A translatable value from the API, e.g. {"en": "Dimmer", "de": "Dimmer"}. */
export type LocalizedText = { [locale: string]: string }

/** Picks the current language, falling back to English. */
export function useLocalized() {
  const { i18n } = useTranslation()
  return (text: LocalizedText | undefined): string => {
    if (!text) return ''
    return text[i18n.resolvedLanguage ?? 'en'] || text.en || ''
  }
}
