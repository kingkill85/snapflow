import type { PlanPlacement, PlanZone, VariantSearchItem } from '@/api/generated/model'
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

/**
 * Copies with new ids, moved by (dx, dy): duplicate, alt-drag and paste. With
 * the image size every copy's centre is kept inside the image (a copy at the
 * edge stays at the edge instead of failing the save with plan.outside_image).
 */
export function duplicatePlacements(placements: PlanPlacement[], dx: number, dy: number, image?: Size): PlanPlacement[] {
  return placements.map((p) => ({
    ...p,
    id: newId(),
    x: image ? clamp(p.x + dx, 0, image.width) : p.x + dx,
    y: image ? clamp(p.y + dy, 0, image.height) : p.y + dy,
    zoneId: null,
  }))
}

/**
 * The move (dx, dy) of the items `ids` (placements and zones) limited so that
 * every moved placement centre and zone corner stays inside the image (the
 * backend refuses others with plan.outside_image). A drag or nudge past the
 * edge stops at it.
 */
export function clampMove(doc: { placements: PlanPlacement[]; zones: PlanZone[] }, ids: string[], dx: number, dy: number, image: Size): { dx: number; dy: number } {
  const set = new Set(ids)
  const points: number[][] = [
    ...doc.placements.filter((p) => set.has(p.id)).map((p) => [p.x, p.y]),
    ...doc.zones.filter((z) => set.has(z.id)).flatMap((z) => z.points),
  ]
  if (points.length === 0) return { dx, dy }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  // Never push items further out than they are (e.g. after an image replacement).
  const lo = (min: number) => Math.min(0, -min)
  const hi = (max: number, size: number) => Math.max(0, size - max)
  return {
    dx: clamp(dx, lo(Math.min(...xs)), hi(Math.max(...xs), image.width)),
    dy: clamp(dy, lo(Math.min(...ys)), hi(Math.max(...ys), image.height)),
  }
}

/** A placement geometry patch (inspector X/Y/W/H) kept valid for the image: centre inside, size above 0 and at most the image's. */
export function clampGeometry(patch: { x?: number; y?: number; width?: number; height?: number }, image: Size) {
  const out: { x?: number; y?: number; width?: number; height?: number } = {}
  if (patch.x !== undefined) out.x = clamp(patch.x, 0, image.width)
  if (patch.y !== undefined) out.y = clamp(patch.y, 0, image.height)
  if (patch.width !== undefined) out.width = Math.min(patch.width, image.width)
  if (patch.height !== undefined) out.height = Math.min(patch.height, image.height)
  return out
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

/**
 * The patch that puts another product (its variant `to`) on a placement
 * (inspector product picker, D216): position, size, rotation, label and
 * "existing" stay; add-ons belong to the old variant and are dropped;
 * instance values are defined by the category and stay only when the new
 * product is of the same category.
 */
export function changeProduct(p: PlanPlacement, to: VariantSearchItem, from: VariantSearchItem | undefined): Partial<PlanPlacement> {
  const sameCategory = from !== undefined && from.categoryId === to.categoryId
  return { variantId: to.id, addonVariantIds: [], instanceValues: sameCategory ? p.instanceValues : {} }
}
