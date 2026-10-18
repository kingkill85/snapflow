import { functionTypesFeature } from '@/features/function-types'
// scaffold:imports

import type { FeatureModule } from './feature'

// The one place where feature modules are wired into the shell.
// `make feature` adds new features above the marker.
export const features: FeatureModule[] = [
  functionTypesFeature,
  // scaffold:features
]
