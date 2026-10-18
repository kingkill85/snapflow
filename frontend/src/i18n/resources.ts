import functionTypesDe from '@/features/function-types/locales/de.json'
import functionTypesEn from '@/features/function-types/locales/en.json'
import commonDe from '@/locales/de/common.json'
import errorsDe from '@/locales/de/errors.json'
import commonEn from '@/locales/en/common.json'
import errorsEn from '@/locales/en/errors.json'
// scaffold:imports

// One namespace per feature. `make feature` adds imports and entries here.
// "en" is the reference: TypeScript checks every t() key against it.
export const resources = {
  en: {
    common: commonEn,
    errors: errorsEn,
    functionTypes: functionTypesEn,
    // scaffold:i18n-en
  },
  de: {
    common: commonDe,
    errors: errorsDe,
    functionTypes: functionTypesDe,
    // scaffold:i18n-de
  },
} as const

export const languages = ['en', 'de'] as const
export type Language = (typeof languages)[number]
