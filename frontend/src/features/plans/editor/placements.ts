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
