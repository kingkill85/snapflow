import type { FeatureModule } from '@/app/feature'

import { RoomTemplatesPage } from './RoomTemplatesPage'

// Room templates (step 3b): Setup, after fields (D442).
export const roomTemplatesFeature: FeatureModule = {
  path: 'catalog/room-templates',
  element: RoomTemplatesPage,
  permission: 'catalog.read',
  nav: { section: 'setup', namespace: 'roomTemplates', labelKey: 'title', order: 4 },
}
