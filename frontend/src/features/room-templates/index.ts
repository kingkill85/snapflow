import type { FeatureModule } from '@/app/feature'

import { RoomTemplatesPage } from './RoomTemplatesPage'

// Room templates (step 3b): after the capability lists (load types).
export const roomTemplatesFeature: FeatureModule = {
  path: 'catalog/room-templates',
  element: RoomTemplatesPage,
  permission: 'catalog.read',
  nav: { section: 'catalog', namespace: 'roomTemplates', labelKey: 'title', order: 4.4 },
}
