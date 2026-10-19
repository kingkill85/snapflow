import { useEffect, useRef } from 'react'

import type { PlanPlacement } from '@/api/generated/model'
import { isModKey, isTypingTarget } from '@/canvas'

import type { EditorAction, EditorState } from './editor-state'
import { duplicateOffset, duplicatePlacements } from './placements'

type Options = {
  state: EditorState
  dispatch: (action: EditorAction) => void
  editable: boolean
  /** Esc also disarms a palette product. */
  onEscape: () => void
}

/** The command a key press means, or undefined. Exported for tests. */
export function shortcutOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>) {
  const mod = isModKey(e)
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod && key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (mod && key === 'y') return 'redo'
  if (mod && key === 'd') return 'duplicate'
  if (mod && key === 'c') return 'copy'
  if (mod && key === 'v') return 'paste'
  if (mod && key === 'a') return 'selectAll'
  if (!mod && (key === 'Delete' || key === 'Backspace')) return 'delete'
  if (key === 'Escape') return 'escape'
  if (!mod && key.startsWith('Arrow')) return 'nudge'
  return undefined
}

/**
 * The editor's keyboard shortcuts (spec 2b): undo/redo, delete, nudge with
 * the arrows (1 px, shift 10 px), duplicate, copy/paste within the plan,
 * select all, Esc. Never while typing in a field or with a dialog open.
 */
export function useShortcuts({ state, dispatch, editable, onEscape }: Options) {
  const clipboard = useRef<PlanPlacement[]>([])
  const latest = useRef({ state, editable, onEscape })
  useEffect(() => {
    latest.current = { state, editable, onEscape }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const command = shortcutOf(e)
      if (!command) return
      const { state, editable, onEscape } = latest.current
      const doc = state.history.present
      const selected = doc.placements.filter((p) => state.selection.includes(p.id))
      const ids = state.selection
      switch (command) {
        case 'escape':
          onEscape()
          dispatch({ type: 'select', ids: [] })
          return
        case 'selectAll':
          e.preventDefault()
          dispatch({ type: 'select', ids: doc.placements.map((p) => p.id) })
          return
        case 'copy':
          if (selected.length > 0) clipboard.current = selected
          return
      }
      if (!editable) return
      e.preventDefault()
      switch (command) {
        case 'undo':
        case 'redo':
          dispatch({ type: command })
          return
        case 'delete':
          if (ids.length > 0) dispatch({ type: 'change', action: { type: 'remove', ids } })
          return
        case 'nudge': {
          if (ids.length === 0) return
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          dispatch({ type: 'change', action: { type: 'moveBy', ids, dx, dy } })
          return
        }
        case 'duplicate':
        case 'paste': {
          const source = command === 'duplicate' ? selected : clipboard.current
          if (source.length === 0) return
          const copies = duplicatePlacements(source, duplicateOffset, duplicateOffset)
          // Pasting again goes further down-right.
          if (command === 'paste') clipboard.current = copies
          dispatch({ type: 'change', action: { type: 'addPlacements', placements: copies }, select: copies.map((c) => c.id) })
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch])
}
