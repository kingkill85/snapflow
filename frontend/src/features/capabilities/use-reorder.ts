import { useState } from 'react'

import { ApiError } from '@/api/client'

/** Tries of a move whose save meets a list changed meanwhile (see move). */
const moveAttempts = 3

type Options = {
  /** Fetches the full list (inactive ones too), fresh. */
  fetchAll: () => Promise<{ id: string }[]>
  /** Saves the new order. */
  save: (ids: string[]) => Promise<unknown>
  /** The order_mismatch code of the list (e.g. load_type.order_mismatch). */
  mismatchCode: string
  /** Refetches what shows the list. */
  invalidate: () => Promise<unknown>
}

/**
 * Up/down moves of a catalog list, as on the product types page: the move is
 * applied to the full list fetched fresh (D29) and retried a few times when
 * the list changed between fetch and save (D92).
 */
export function useReorder({ fetchAll, save, mismatchCode, invalidate }: Options) {
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<unknown>(null)

  const move = async (itemId: string, neighbourId: string, direction: 'up' | 'down') => {
    setMoving(true)
    setMoveError(null)
    for (let attempt = 1; ; attempt++) {
      let gone = false
      try {
        const all = await fetchAll()
        const ids = all.map((i) => i.id).filter((id) => id !== itemId)
        const at = ids.indexOf(neighbourId)
        if (at < 0 || ids.length === all.length) {
          gone = true
          throw new ApiError({ status: 422, code: mismatchCode })
        }
        ids.splice(direction === 'up' ? at : at + 1, 0, itemId)
        await save(ids)
        break
      } catch (error) {
        if (!gone && attempt < moveAttempts && error instanceof ApiError && error.code === mismatchCode) continue
        setMoveError(error)
        break
      }
    }
    await invalidate()
    setMoving(false)
  }

  return { move, moving, moveError }
}
