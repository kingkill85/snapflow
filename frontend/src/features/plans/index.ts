import type { FeatureModule } from '@/app/feature'

import { EditorRoute } from './EditorRoute'
import { editorRoute } from './paths'

export { PlansSection } from './PlansSection'

/** The floorplan editor (step 2b); the plans list lives on the project page. */
export const plansFeature: FeatureModule = {
  path: editorRoute,
  element: EditorRoute,
  permission: 'projects.read',
}
