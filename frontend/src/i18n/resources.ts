import authDe from '@/features/auth/locales/de.json'
import authEn from '@/features/auth/locales/en.json'
import capabilitiesDe from '@/features/capabilities/locales/de.json'
import capabilitiesEn from '@/features/capabilities/locales/en.json'
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
import categoriesDe from '@/features/categories/locales/de.json'
import categoriesEn from '@/features/categories/locales/en.json'
import productTypesDe from '@/features/product-types/locales/de.json'
import productTypesEn from '@/features/product-types/locales/en.json'
import catalogDe from '@/catalog/locales/de.json'
import catalogEn from '@/catalog/locales/en.json'
import productsDe from '@/features/products/locales/de.json'
import productsEn from '@/features/products/locales/en.json'
import importsDe from '@/features/imports/locales/de.json'
import importsEn from '@/features/imports/locales/en.json'
import projectsDe from '@/features/projects/locales/de.json'
import projectsEn from '@/features/projects/locales/en.json'
import plansDe from '@/features/plans/locales/de.json'
import plansEn from '@/features/plans/locales/en.json'
import bomDe from '@/features/bom/locales/de.json'
import bomEn from '@/features/bom/locales/en.json'
import needsDe from '@/features/needs/locales/de.json'
import needsEn from '@/features/needs/locales/en.json'
import proposalsDe from '@/features/proposals/locales/de.json'
import proposalsEn from '@/features/proposals/locales/en.json'
import roomTemplatesDe from '@/features/room-templates/locales/de.json'
import roomTemplatesEn from '@/features/room-templates/locales/en.json'
import networksDe from '@/features/networks/locales/de.json'
import networksEn from '@/features/networks/locales/en.json'
import checksDe from '@/features/checks/locales/de.json'
import checksEn from '@/features/checks/locales/en.json'
import installationDe from '@/features/installation/locales/de.json'
import installationEn from '@/features/installation/locales/en.json'
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
    categories: categoriesEn,
    catalog: catalogEn,
    products: productsEn,
    imports: importsEn,
    projects: projectsEn,
    plans: plansEn,
    bom: bomEn,
    needs: needsEn,
    proposals: proposalsEn,
    capabilities: capabilitiesEn,
    roomTemplates: roomTemplatesEn,
    networks: networksEn,
    checks: checksEn,
    installation: installationEn,
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
    categories: categoriesDe,
    catalog: catalogDe,
    products: productsDe,
    imports: importsDe,
    projects: projectsDe,
    plans: plansDe,
    bom: bomDe,
    needs: needsDe,
    proposals: proposalsDe,
    capabilities: capabilitiesDe,
    roomTemplates: roomTemplatesDe,
    networks: networksDe,
    checks: checksDe,
    installation: installationDe,
    // scaffold:i18n-de
  },
} as const

// The UI languages (switcher, i18next). Content languages are contentLocales.
export const languages = ['en', 'de'] as const
export type Language = (typeof languages)[number]
