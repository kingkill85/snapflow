import { applyDocumentAction, type DocumentAction, itemIds, type PlanDocument } from './document'
import { commit, type History, initHistory, redo, undo } from './history'

/**
 * The editor's state: the document with its history, and the selection
 * (ids of placements and zones). The selection is not part of the history:
 * undo never changes what is selected, except dropping ids that no longer
 * exist.
 */
export type EditorState = {
  history: History<PlanDocument>
  selection: string[]
}

export type EditorAction =
  /** A content change; `key` merges consecutive changes of one field into one step. */
  | { type: 'change'; action: DocumentAction; key?: string; select?: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; ids: string[] }
  /** Adds or removes ids (shift-click). */
  | { type: 'toggleSelect'; ids: string[] }
  /** Starts over from a loaded document (open, reload), with an empty history. */
  | { type: 'load'; document: PlanDocument }

export const initEditor = (document: PlanDocument): EditorState => ({ history: initHistory(document), selection: [] })

function pruneSelection(selection: string[], doc: PlanDocument): string[] {
  if (selection.length === 0) return selection
  const ids = itemIds(doc)
  const kept = selection.filter((id) => ids.has(id))
  return kept.length === selection.length ? selection : kept
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'change': {
      const next = applyDocumentAction(state.history.present, action.action)
      const history = commit(state.history, next, action.key)
      const selection = action.select ?? state.selection
      if (history === state.history && selection === state.selection) return state
      return { history, selection: pruneSelection(selection, history.present) }
    }
    case 'undo':
    case 'redo': {
      const history = action.type === 'undo' ? undo(state.history) : redo(state.history)
      if (history === state.history) return state
      return { history, selection: pruneSelection(state.selection, history.present) }
    }
    case 'select':
      return { ...state, selection: pruneSelection(action.ids, state.history.present) }
    case 'toggleSelect': {
      const current = new Set(state.selection)
      for (const id of action.ids) {
        if (current.has(id)) current.delete(id)
        else current.add(id)
      }
      return { ...state, selection: pruneSelection([...current], state.history.present) }
    }
    case 'load':
      return initEditor(action.document)
  }
}
