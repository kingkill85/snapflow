import type { PlanNeed, PlanPlacement } from '@/api/generated/model'
import type { Size } from '@/canvas'

import type { DocumentAction, PlanDocument } from './document'
import { duplicateSymbols, maxNeeds } from './needs'
import { duplicatePlacements } from './placements'

export type CopyResult = {
  /** One step for everything copied; null when nothing is copied. */
  action: DocumentAction | null
  placements: PlanPlacement[]
  needs: PlanNeed[]
  /** Load symbols left out: their function type or load type is inactive or gone. */
  skipped: number
  /** Nothing copied: the plan would have more than `maxNeeds` needs. */
  overLimit: boolean
}

/**
 * Copies of placements and load symbols moved by (dx, dy), kept inside the
 * image: Ctrl+D, paste and alt-drag. Symbols a new need could not have
 * (`usable`) are skipped; the rest is one step (`batch` when both kinds are
 * copied). Refused as a whole when the plan would exceed `maxNeeds`.
 */
export function copyItems(
  doc: PlanDocument,
  source: { placements: PlanPlacement[]; needs: PlanNeed[] },
  dx: number,
  dy: number,
  image: Size,
  usable: (n: PlanNeed) => boolean,
): CopyResult {
  const symbols = source.needs.filter((n) => n.x !== null && n.y !== null)
  const needs = duplicateSymbols(symbols, dx, dy, image, usable)
  const skipped = symbols.length - needs.length
  if (doc.needs.length + needs.length > maxNeeds) return { action: null, placements: [], needs: [], skipped, overLimit: true }
  const placements = duplicatePlacements(source.placements, dx, dy, image)
  const actions: DocumentAction[] = [
    ...(placements.length > 0 ? [{ type: 'addPlacements' as const, placements }] : []),
    ...(needs.length > 0 ? [{ type: 'addNeeds' as const, needs }] : []),
  ]
  const action = actions.length === 0 ? null : actions.length === 1 ? actions[0] : { type: 'batch' as const, actions }
  return { action, placements, needs, skipped, overLimit: false }
}
