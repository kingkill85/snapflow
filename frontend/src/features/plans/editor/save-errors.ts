import { ApiError } from '@/api/client'
import type { FieldError } from '@/api/generated/model'

import type { PlanDocument } from './document'

const itemLocation = /^body\.(placements|zones)\[(\d+)\]/

/**
 * The field errors of a refused save by item id: `body.placements[i].…`
 * belongs to the i-th placement of the snapshot that was sent (the document
 * may have changed since). Errors elsewhere are left to the general message.
 */
export function saveErrorsByItem(error: unknown, snapshot: PlanDocument, message: (field: FieldError) => string): Map<string, string[]> {
  const byItem = new Map<string, string[]>()
  if (!(error instanceof ApiError)) return byItem
  for (const field of error.fields) {
    const match = itemLocation.exec(field.location)
    if (!match) continue
    const list = match[1] === 'placements' ? snapshot.placements : snapshot.zones
    const item = list[Number(match[2])]
    if (!item) continue
    const messages = byItem.get(item.id) ?? []
    const text = message(field)
    if (!messages.includes(text)) messages.push(text)
    byItem.set(item.id, messages)
  }
  return byItem
}
