import { useEffect, useId, useRef } from 'react'

import type { MoveAction } from './repeater'

const fieldSelector = 'input, select, textarea'
const controlSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

type Items = { id: string }[]

/**
 * Keeps keyboard focus in a repeater when its items change: a new item's
 * first field, after a remove the next item's first control (or the add
 * button), after a move the same button, or the other enabled move button
 * when the item reached an end. Give each RepeaterItem `itemId={field.id}`
 * (the useFieldArray id), the add button below the list
 * `data-repeater-add={listId}`, and call the matching function with each change.
 */
export function useRepeaterFocus(fields: Items) {
  const listId = useId()
  const pending = useRef<((list: Items) => HTMLElement | null | undefined) | null>(null)

  useEffect(() => {
    const find = pending.current
    if (!find) return
    pending.current = null
    find(fields)?.focus()
  }, [fields])

  const item = (list: Items, index: number) =>
    list[index] ? document.querySelector<HTMLElement>(`[data-repeater-item="${list[index].id}"]`) : null
  const addButton = () => document.querySelector<HTMLElement>(`[data-repeater-add="${listId}"]`)
  return {
    listId,
    /** An item was added at `index`. */
    added: (index: number) => {
      pending.current = (list) => item(list, index)?.querySelector<HTMLElement>(fieldSelector)
    },
    /** The item at `index` was removed. */
    removed: (index: number) => {
      pending.current = (list) => item(list, index)?.querySelector<HTMLElement>(controlSelector) ?? addButton()
    },
    /** An item was moved to `to` with the given control. */
    moved: (to: number, action: MoveAction) => {
      pending.current = (list) => {
        const el = item(list, to)
        return el?.querySelector<HTMLElement>(`[data-move="${action}"]:not(:disabled)`) ?? el?.querySelector<HTMLElement>('[data-move]:not(:disabled)')
      }
    },
  }
}
