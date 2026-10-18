import type { FeatureModule } from '@/app/feature'

import { TenantsPage } from './TenantsPage'

export const tenantsFeature: FeatureModule = {
  path: 'admin/tenants',
  element: TenantsPage,
  permission: 'tenants.manage',
  nav: { section: 'admin', namespace: 'tenants', labelKey: 'title' },
}
