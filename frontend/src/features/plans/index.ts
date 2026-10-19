import type { FeatureModule } from '@/app/feature'

import { EditorRoute } from './EditorRoute'
import { BoardRoute } from './board/BoardRoute'
import { boardRoute, editorRoute } from './paths'

export { PlansSection } from './PlansSection'

/** The floorplan editor (step 2b); the plans list lives on the project page. */
export const plansFeature: FeatureModule = {
  path: editorRoute,
  element: EditorRoute,
  permission: 'projects.read',
}

/** The board editor (step 3c). */
export const boardsFeature: FeatureModule = {
  path: boardRoute,
  element: BoardRoute,
  permission: 'projects.read',
}
export { groupPalette, type PaletteProduct, paletteProducts, useCatalogVariants } from './editor/catalog'
