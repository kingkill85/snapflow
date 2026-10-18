import type { FeatureModule } from '@/app/feature'

import { ProductTypeEditorPage } from './ProductTypeEditorPage'
import { ProductTypesPage } from './ProductTypesPage'

export const productTypesFeature: FeatureModule = {
  path: 'catalog/product-types',
  element: ProductTypesPage,
  permission: 'catalog.read',
  nav: { section: 'catalog', namespace: 'productTypes', labelKey: 'title', order: 2 },
  pages: [
    { path: 'new', element: ProductTypeEditorPage, permission: 'catalog.write' },
    // Read-only without catalog.write.
    { path: ':id', element: ProductTypeEditorPage },
  ],
}
