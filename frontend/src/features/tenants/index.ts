import type { FeatureModule } from '@/app/feature'

import { CompanyProfilePage } from './CompanyProfilePage'
import { TenantsPage } from './TenantsPage'

export const tenantsFeature: FeatureModule = {
  path: 'admin/tenants',
  element: TenantsPage,
  permission: 'tenants.manage',
  nav: { section: 'admin', namespace: 'tenants', labelKey: 'title', order: 2 },
}

/** The own tenant's letterhead, for tenant admins (and admins): Administration → Company profile (D261). */
export const companyProfileFeature: FeatureModule = {
  path: 'admin/company',
  element: CompanyProfilePage,
  permission: 'tenants.profile',
  nav: { section: 'admin', namespace: 'tenants', labelKey: 'profile.title', order: 4 },
}
