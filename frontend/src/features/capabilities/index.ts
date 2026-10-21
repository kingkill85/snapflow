import type { FeatureModule } from '@/app/feature'

import { CatalogFieldsPage } from './CatalogFieldsPage'
import { LoadTypesPage } from './LoadTypesPage'
import { OutputKindsPage } from './OutputKindsPage'

// Setup (D442): fields 3, channel kinds 5, load types 6.
export const catalogFieldsFeature: FeatureModule = {
  path: 'catalog/fields',
  element: CatalogFieldsPage,
  permission: 'catalog.read',
  nav: {
    section: 'setup',
    namespace: 'capabilities',
    labelKey: 'fields.title',
    order: 3,
  },
}

export const outputKindsFeature: FeatureModule = {
  path: 'catalog/output-kinds',
  element: OutputKindsPage,
  permission: 'catalog.read',
  nav: {
    section: 'setup',
    namespace: 'capabilities',
    labelKey: 'outputKinds.title',
    order: 5,
  },
}

export const loadTypesFeature: FeatureModule = {
  path: 'catalog/load-types',
  element: LoadTypesPage,
  permission: 'catalog.read',
  nav: {
    section: 'setup',
    namespace: 'capabilities',
    labelKey: 'loadTypes.title',
    order: 6,
  },
}

// The field dialog, also opened from a category attribute ("Create a new field…", D445).
export { CatalogFieldFormDialog } from './CatalogFieldFormDialog'
export type { CatalogFieldFormValues } from './field-form'
