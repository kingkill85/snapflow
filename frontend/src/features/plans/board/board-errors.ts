import { ApiError } from '@/api/client'
import type { FieldError } from '@/api/generated/model'

import type { BoardDocument } from './board'

const moduleLocation = /^body\.(modules|rows)\[(\d+)\]/

/** Field errors of a refused board save by module id (`body.modules[i].…` of the snapshot sent); row errors stay general. */
export function boardErrorsByModule(error: unknown, snapshot: BoardDocument, message: (field: FieldError) => string): Map<string, string[]> {
  const byItem = new Map<string, string[]>()
  if (!(error instanceof ApiError)) return byItem
  for (const field of error.fields) {
    const match = moduleLocation.exec(field.location)
    if (!match || match[1] !== 'modules') continue
    const item = snapshot.modules[Number(match[2])]
    if (!item) continue
    const list = byItem.get(item.id) ?? []
    const text = message(field)
    if (!list.includes(text)) list.push(text)
    byItem.set(item.id, list)
  }
  return byItem
}
