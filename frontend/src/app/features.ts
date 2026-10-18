import { profileFeature } from '@/features/auth'
import { functionTypesFeature } from '@/features/function-types'
import { rolesFeature } from '@/features/roles'
import { tenantsFeature } from '@/features/tenants'
import { usersFeature } from '@/features/users'
// scaffold:imports

import type { FeatureModule } from './feature'

// The one place where feature modules are wired into the shell.
// `make feature` adds new features above the marker.
export const features: FeatureModule[] = [
  functionTypesFeature,
  usersFeature,
  tenantsFeature,
  rolesFeature,
  profileFeature,
  // scaffold:features
]
