import type { FeatureModule } from '@/app/feature'

import { ProductTypesPage } from './ProductTypesPage'

export const productTypesFeature: FeatureModule = {
  path: 'catalog/product-types',
  element: ProductTypesPage,
  permission: 'catalog.read',
  nav: { section: 'catalog', namespace: 'productTypes', labelKey: 'title', order: 3 },
}
