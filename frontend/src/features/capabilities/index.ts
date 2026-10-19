import type { FeatureModule } from '@/app/feature'

import { CatalogFieldsPage } from './CatalogFieldsPage'
import { LoadTypesPage } from './LoadTypesPage'
import { OutputKindsPage } from './OutputKindsPage'

// Catalog capabilities (step 3a): after function types, before imports.
export const catalogFieldsFeature: FeatureModule = {
  path: 'catalog/fields',
  element: CatalogFieldsPage,
  permission: 'catalog.read',
  nav: {
    section: 'catalog',
    namespace: 'capabilities',
    labelKey: 'fields.title',
    order: 4.1,
  },
}

export const outputKindsFeature: FeatureModule = {
  path: 'catalog/output-kinds',
  element: OutputKindsPage,
  permission: 'catalog.read',
  nav: {
    section: 'catalog',
    namespace: 'capabilities',
    labelKey: 'outputKinds.title',
    order: 4.2,
  },
}

export const loadTypesFeature: FeatureModule = {
  path: 'catalog/load-types',
  element: LoadTypesPage,
  permission: 'catalog.read',
  nav: {
    section: 'catalog',
    namespace: 'capabilities',
    labelKey: 'loadTypes.title',
    order: 4.3,
  },
}
