import type { FeatureModule } from '@/app/feature'

import { RolesPage } from './RolesPage'

export const rolesFeature: FeatureModule = {
  path: 'admin/roles',
  element: RolesPage,
  nav: { section: 'admin', namespace: 'roles', labelKey: 'title' },
}
