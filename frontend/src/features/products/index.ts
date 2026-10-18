import type { FeatureModule } from '@/app/feature'

import { ProductEditorPage } from './ProductEditorPage'
import { ProductsPage } from './ProductsPage'
import { VariantEditorPage } from './VariantEditorPage'

export const productsFeature: FeatureModule = {
  path: 'catalog/products',
  element: ProductsPage,
  permission: 'catalog.read',
  nav: { section: 'catalog', namespace: 'products', labelKey: 'title' },
  pages: [
    { path: 'new', element: ProductEditorPage, permission: 'catalog.write' },
    // Read-only without catalog.write.
    { path: ':id', element: ProductEditorPage },
    { path: ':id/variants/new', element: VariantEditorPage, permission: 'catalog.write' },
    { path: ':id/variants/:variantId', element: VariantEditorPage },
  ],
}
