import authDe from '@/features/auth/locales/de.json'
import authEn from '@/features/auth/locales/en.json'
import functionTypesDe from '@/features/function-types/locales/de.json'
import functionTypesEn from '@/features/function-types/locales/en.json'
import rolesDe from '@/features/roles/locales/de.json'
import rolesEn from '@/features/roles/locales/en.json'
import tenantsDe from '@/features/tenants/locales/de.json'
import tenantsEn from '@/features/tenants/locales/en.json'
import usersDe from '@/features/users/locales/de.json'
import usersEn from '@/features/users/locales/en.json'
import commonDe from '@/locales/de/common.json'
import errorsDe from '@/locales/de/errors.json'
import commonEn from '@/locales/en/common.json'
import errorsEn from '@/locales/en/errors.json'
import productTypesDe from '@/features/product-types/locales/de.json'
import productTypesEn from '@/features/product-types/locales/en.json'
import catalogDe from '@/catalog/locales/de.json'
import catalogEn from '@/catalog/locales/en.json'
import productsDe from '@/features/products/locales/de.json'
import productsEn from '@/features/products/locales/en.json'
// scaffold:imports

// One namespace per feature. `make feature` adds imports and entries here.
// "en" is the reference: TypeScript checks every t() key against it.
export const resources = {
  en: {
    common: commonEn,
    errors: errorsEn,
    functionTypes: functionTypesEn,
    auth: authEn,
    users: usersEn,
    tenants: tenantsEn,
    roles: rolesEn,
    productTypes: productTypesEn,
    catalog: catalogEn,
    products: productsEn,
    // scaffold:i18n-en
  },
  de: {
    common: commonDe,
    errors: errorsDe,
    functionTypes: functionTypesDe,
    auth: authDe,
    users: usersDe,
    tenants: tenantsDe,
    roles: rolesDe,
    productTypes: productTypesDe,
    catalog: catalogDe,
    products: productsDe,
    // scaffold:i18n-de
  },
} as const

export const languages = ['en', 'de'] as const
export type Language = (typeof languages)[number]
