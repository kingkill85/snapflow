import type { FeatureModule } from '@/app/feature'

import { ProfilePage } from './ProfilePage'

export { LoginPage } from './LoginPage'

export const profileFeature: FeatureModule = {
  path: 'profile',
  element: ProfilePage,
}
