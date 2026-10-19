import { useEffect, useRef } from 'react'

import type { PlanNeed, PlanPlacement } from '@/api/generated/model'
import { isCanvasKeyTarget, isModKey, isTypingTarget, type Size } from '@/canvas'

import type { EditorAction, EditorState } from './editor-state'
import { duplicateSymbols } from './needs'
import { clampMove, duplicateOffset, duplicatePlacements } from './placements'

type Options = {
  state: EditorState
  dispatch: (action: EditorAction) => void
  editable: boolean
  /** The plan image: nudges, duplicates and pastes stay inside it. */
  image: Size
  /** Esc also disarms a palette product. */
  onEscape: () => void
  /** What select-all selects (visible placements and zones); all placements by default. */
  selectable?: () => string[]
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
export function useShortcuts({ state, dispatch, editable, image, onEscape, selectable }: Options) {
  const clipboard = useRef<{ placements: PlanPlacement[]; needs: PlanNeed[] }>({ placements: [], needs: [] })
  const latest = useRef({ state, editable, image, onEscape, selectable })
  useEffect(() => {
    latest.current = { state, editable, image, onEscape, selectable }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const command = shortcutOf(e)
      if (!command) return
      // Plain keys (arrows, Delete, Backspace) belong to a focused control (button, switch, tab, ...).
      if ((command === 'nudge' || command === 'delete') && !isCanvasKeyTarget(e.target)) return
      const { state, editable, image, onEscape, selectable } = latest.current
      const doc = state.history.present
      const selected = doc.placements.filter((p) => state.selection.includes(p.id))
      const selectedNeeds = doc.needs.filter((n) => state.selection.includes(n.id))
      const ids = state.selection
      switch (command) {
        case 'escape':
          onEscape()
          dispatch({ type: 'select', ids: [] })
          return
        case 'selectAll':
          e.preventDefault()
          dispatch({ type: 'select', ids: selectable ? selectable() : doc.placements.map((p) => p.id) })
          return
        case 'copy':
          if (selected.length + selectedNeeds.length > 0) clipboard.current = { placements: selected, needs: selectedNeeds }
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
          const move = clampMove(
            doc,
            ids,
            e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
            e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
            image,
          )
          const { dx, dy } = move
          if (dx === 0 && dy === 0) return
          dispatch({ type: 'change', action: { type: 'moveBy', ids, dx, dy } })
          return
        }
        case 'duplicate':
        case 'paste': {
          const source = command === 'duplicate' ? { placements: selected, needs: selectedNeeds } : clipboard.current
          if (source.placements.length + source.needs.length === 0) return
          const copies = duplicatePlacements(source.placements, duplicateOffset, duplicateOffset, image)
          const needCopies = duplicateSymbols(source.needs, duplicateOffset, duplicateOffset, image)
          // Pasting again goes further down-right.
          if (command === 'paste') clipboard.current = { placements: copies, needs: needCopies }
          const select = [...copies.map((c) => c.id), ...needCopies.map((c) => c.id)]
          if (needCopies.length === 0) {
            dispatch({ type: 'change', action: { type: 'addPlacements', placements: copies }, select })
          } else if (copies.length === 0) {
            dispatch({ type: 'change', action: { type: 'addNeeds', needs: needCopies }, select })
          } else {
            dispatch({ type: 'change', action: { type: 'batch', actions: [{ type: 'addPlacements', placements: copies }, { type: 'addNeeds', needs: needCopies }] }, select })
          }
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch])
}
