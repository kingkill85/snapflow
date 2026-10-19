import type { PlanPlacement, VariantSearchItem } from '@/api/generated/model'
import { clamp, type Point, type Size } from '@/canvas'

import { newId } from './document'

/** A new placement of a variant centred at a point (kept inside the image). */
export function newPlacement(variant: VariantSearchItem, at: Point, size: Size, image: Size): PlanPlacement {
  return {
    id: newId(),
    variantId: variant.id,
    x: Math.round(clamp(at.x, 0, image.width)),
    y: Math.round(clamp(at.y, 0, image.height)),
    width: Math.min(size.width, image.width),
    height: Math.min(size.height, image.height),
    rotation: 0,
    label: '',
    existing: false,
    addonVariantIds: [],
    instanceValues: {},
    zoneId: null,
  }
}

/** Copies with new ids, moved by (dx, dy): duplicate, alt-drag and paste. */
export function duplicatePlacements(placements: PlanPlacement[], dx: number, dy: number): PlanPlacement[] {
  return placements.map((p) => ({ ...p, id: newId(), x: p.x + dx, y: p.y + dy, zoneId: null }))
}

/** How far duplicates and pastes are offset, in image pixels. */
export const duplicateOffset = 20

/**
 * "Resize all of this product" (smart sizing): the size change of one
 * placement for every placement of the same product (centres stay), as the
 * changes of one `updatePlacements` (one undo step). Only the placement
 * itself when its variant is unknown.
 */
export function resizeChanges(
  placements: PlanPlacement[],
  id: string,
  patch: { width?: number; height?: number; x?: number; y?: number },
  variants: Map<string, VariantSearchItem>,
  all: boolean,
): { id: string; patch: Partial<PlanPlacement> }[] {
  const target = placements.find((p) => p.id === id)
  const productId = target?.variantId ? variants.get(target.variantId)?.productId : undefined
  const changes: { id: string; patch: Partial<PlanPlacement> }[] = [{ id, patch }]
  if (!all || !productId) return changes
  const size: Partial<PlanPlacement> = {}
  if (patch.width !== undefined) size.width = patch.width
  if (patch.height !== undefined) size.height = patch.height
  for (const p of placements) {
    if (p.id !== id && p.variantId && variants.get(p.variantId)?.productId === productId) changes.push({ id: p.id, patch: size })
  }
  return changes
}
