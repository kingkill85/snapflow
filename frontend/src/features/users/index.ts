import type { FeatureModule } from '@/app/feature'

import { UsersPage } from './UsersPage'

export const usersFeature: FeatureModule = {
  path: 'admin/users',
  element: UsersPage,
  permission: 'users.manage',
  nav: { section: 'admin', namespace: 'users', labelKey: 'title', order: 1 },
}
