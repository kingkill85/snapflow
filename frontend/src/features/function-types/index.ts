import type { FeatureModule } from '@/app/feature'

import { FunctionTypesPage } from './FunctionTypesPage'

export const functionTypesFeature: FeatureModule = {
  path: 'catalog/function-types',
  element: FunctionTypesPage,
  nav: { section: 'setup', namespace: 'functionTypes', labelKey: 'title', order: 2 },
}
