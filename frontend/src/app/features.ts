import { profileFeature } from '@/features/auth'
import { functionTypesFeature } from '@/features/function-types'
import { rolesFeature } from '@/features/roles'
import { companyProfileFeature, tenantsFeature } from '@/features/tenants'
import { usersFeature } from '@/features/users'
import { categoriesFeature } from '@/features/categories'
import { productTypesFeature } from '@/features/product-types'
import { productsFeature } from '@/features/products'
import { importsFeature } from '@/features/imports'
import { projectsFeature } from '@/features/projects'
import { plansFeature } from '@/features/plans'
import { catalogFieldsFeature, loadTypesFeature, outputKindsFeature } from '@/features/capabilities'
// scaffold:imports

import type { FeatureModule } from './feature'

// The one place where feature modules are wired into the shell.
// `make feature` adds new features above the marker.
export const features: FeatureModule[] = [
  // First: the home page sends everybody to the first page they may see.
  projectsFeature,
  functionTypesFeature,
  usersFeature,
  tenantsFeature,
  companyProfileFeature,
  rolesFeature,
  profileFeature,
  productTypesFeature,
  categoriesFeature,
  productsFeature,
  importsFeature,
  plansFeature,
  catalogFieldsFeature,
  outputKindsFeature,
  loadTypesFeature,
  // scaffold:features
]
