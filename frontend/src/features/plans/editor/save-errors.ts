import { ApiError } from '@/api/client'
import type { FieldError, PlanNeed, PlanPlacement } from '@/api/generated/model'

import type { PlanDocument } from './document'

const itemLocation = /^body\.(placements|zones|needs)\[(\d+)\]/

/**
 * The field errors of a refused save by item id: `body.placements[i].…`
 * belongs to the i-th placement of the snapshot that was sent (the document
 * may have changed since); `body.needs[i].…` to the i-th need (shown at its
 * row, see `selectionFor`). Errors elsewhere are left to the general message.
 */
export function saveErrorsByItem(error: unknown, snapshot: PlanDocument, message: (field: FieldError) => string): Map<string, string[]> {
  const byItem = new Map<string, string[]>()
  if (!(error instanceof ApiError)) return byItem
  for (const field of error.fields) {
    const match = itemLocation.exec(field.location)
    if (!match) continue
    const list = match[1] === 'placements' ? snapshot.placements : match[1] === 'zones' ? snapshot.zones : snapshot.needs
    const item = list[Number(match[2])]
    if (!item) continue
    const messages = byItem.get(item.id) ?? []
    const text = message(field)
    if (!messages.includes(text)) messages.push(text)
    byItem.set(item.id, messages)
  }
  return byItem
}

/**
 * What to select to show an item's error: a need without position is shown
 * in its zone's inspector, everything else (placement, zone, load symbol) is
 * selected itself.
 */
export function selectionFor(id: string, doc: PlanDocument): string {
  const need = doc.needs.find((n) => n.id === id)
  if (need && (need.x === null || need.y === null) && need.zoneId) return need.zoneId
  return id
}

/** How the save-error list names items. */
export type ItemNames = {
  /** A need in plain words (the shared need text). */
  need: (need: PlanNeed) => string
  /** A placement's label or product name; undefined when it has neither. */
  placement: (placement: PlanPlacement) => string | undefined
}

/**
 * The name of an item with a save error: a need (row or load symbol) in
 * plain words, a placement by label or product, a zone by name; undefined
 * when there is none (the list then numbers it).
 */
export function itemName(id: string, doc: PlanDocument, names: ItemNames): string | undefined {
  const need = doc.needs.find((n) => n.id === id)
  if (need) return names.need(need)
  const placement = doc.placements.find((p) => p.id === id)
  if (placement) return names.placement(placement)
  return doc.zones.find((z) => z.id === id)?.name || undefined
}
