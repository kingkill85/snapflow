import type { FeatureModule } from '@/app/feature'

import { CategoryEditorPage } from './CategoryEditorPage'
import { CategoriesPage } from './CategoriesPage'

export const categoriesFeature: FeatureModule = {
  path: 'catalog/categories',
  element: CategoriesPage,
  permission: 'catalog.read',
  nav: { section: 'catalog', namespace: 'categories', labelKey: 'title', order: 2 },
  pages: [
    { path: 'new', element: CategoryEditorPage, permission: 'catalog.write' },
    // Read-only without catalog.write.
    { path: ':id', element: CategoryEditorPage },
  ],
}
