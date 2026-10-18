import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import { languages, resources } from './resources'

// Screen readers, hyphenation and spell checking follow the document's
// language, so keep <html lang> in step with the UI language.
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = i18n.resolvedLanguage ?? lng
})

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: languages,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: Object.keys(resources.en),
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
  })

export default i18n
