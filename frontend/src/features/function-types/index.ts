import type { FeatureModule } from '@/app/feature'

import { FunctionTypesPage } from './FunctionTypesPage'

export const functionTypesFeature: FeatureModule = {
  path: 'catalog/function-types',
  element: FunctionTypesPage,
  nav: { section: 'catalog', namespace: 'functionTypes', labelKey: 'title', order: 3 },
}
