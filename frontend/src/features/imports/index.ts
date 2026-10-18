import type { FeatureModule } from '@/app/feature'

import { ImportRunPage } from './ImportRunPage'
import { ImportsPage } from './ImportsPage'
import { NewImportPage } from './NewImportPage'

export const importsFeature: FeatureModule = {
  path: 'catalog/imports',
  element: ImportsPage,
  // The import writes the catalog: everything in it needs catalog.write (D134).
  permission: 'catalog.write',
  nav: { section: 'catalog', namespace: 'imports', labelKey: 'title', order: 5 },
  pages: [
    { path: 'new', element: NewImportPage },
    { path: ':id', element: ImportRunPage },
  ],
}
