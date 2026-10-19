import type { CategoryRef, PlanNeed, PlanPlacement, PlanZone, ProductTypeRef, VariantSearchItem } from '@/api/generated/model'

import { isSymbol } from './document'

import type { PaletteProduct } from './catalog'

/**
 * What the canvas hides (view state, not saved, not in the history): product
 * types and categories by id, all zones, single zones. Hidden items are not
 * drawn, so they cannot be hit, selected by the rubber band or select-all,
 * and are left out of the PNG export.
 */
export type Layers = {
  hiddenProductTypes: Set<string>
  hiddenCategories: Set<string>
  zonesHidden: boolean
  hiddenZones: Set<string>
  /** Load symbols (needs with a position). */
  needsHidden: boolean
}

export const allVisible = (): Layers => ({ hiddenProductTypes: new Set(), hiddenCategories: new Set(), zonesHidden: false, hiddenZones: new Set(), needsHidden: false })

/** The load symbols the canvas shows. */
export const visibleSymbols = (needs: PlanNeed[], layers: Layers) => (layers.needsHidden ? [] : needs.filter(isSymbol))

/** Placements of deleted variants have neither type nor category: always shown (they need attention). */
export function placementVisible(p: PlanPlacement, layers: Layers, variants: Map<string, VariantSearchItem>): boolean {
  const v = p.variantId ? variants.get(p.variantId) : undefined
  if (!v) return true
  return !layers.hiddenProductTypes.has(v.productTypeId) && !layers.hiddenCategories.has(v.categoryId)
}

export const zoneVisible = (z: PlanZone, layers: Layers) => !layers.zonesHidden && !layers.hiddenZones.has(z.id)

/** A set with the id added or removed. */
export function toggled(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** The ids of every visible item: placements, zones and load symbols (select-all). */
export const visibleIds = (doc: { placements: PlanPlacement[]; zones: PlanZone[]; needs: PlanNeed[] }, layers: Layers, variants: Map<string, VariantSearchItem>) => [
  ...doc.zones.filter((z) => zoneVisible(z, layers)).map((z) => z.id),
  ...doc.placements.filter((p) => placementVisible(p, layers, variants)).map((p) => p.id),
  ...visibleSymbols(doc.needs, layers).map((n) => n.id),
]

/** The product types and categories on the plan or in the palette, in first-seen order. */
export function layerGroups(placements: PlanPlacement[], products: PaletteProduct[], variants: Map<string, VariantSearchItem>) {
  const types = new Map<string, ProductTypeRef>()
  const categories = new Map<string, CategoryRef>()
  for (const p of placements) {
    const v = p.variantId ? variants.get(p.variantId) : undefined
    if (!v) continue
    if (!types.has(v.productTypeId)) types.set(v.productTypeId, v.productType)
    if (!categories.has(v.categoryId)) categories.set(v.categoryId, v.category)
  }
  for (const p of products) {
    if (!types.has(p.productType.id)) types.set(p.productType.id, p.productType)
    if (!categories.has(p.category.id)) categories.set(p.category.id, p.category)
  }
  return { types: [...types.values()], categories: [...categories.values()] }
}

