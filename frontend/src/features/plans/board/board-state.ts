import { commit, type History, initHistory, redo, undo } from '../editor/history'
import { applyBoardAction, type BoardAction, type BoardDocument, boardItemIds } from './board'

/** The board editor's state: the document with its history (shared with the floorplan editor) and the selected module ids. */
export type BoardState = {
  history: History<BoardDocument>
  selection: string[]
}

export type BoardEditorAction =
  | { type: 'change'; action: BoardAction; key?: string; select?: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; ids: string[] }
  | { type: 'toggleSelect'; ids: string[] }
  | { type: 'load'; document: BoardDocument }
  /**
   * The rows and module places the server fitted on save (D357) differ from
   * the document saved: when that document is still the present one, it is
   * replaced in place (no new undo step; an undo goes back to the step before).
   */
  | { type: 'adopt'; from: BoardDocument; document: BoardDocument }

export const initBoard = (document: BoardDocument): BoardState => ({ history: initHistory(document), selection: [] })

function prune(selection: string[], doc: BoardDocument): string[] {
  if (selection.length === 0) return selection
  const ids = boardItemIds(doc)
  const kept = selection.filter((id) => ids.has(id))
  return kept.length === selection.length ? selection : kept
}

export function boardReducer(state: BoardState, action: BoardEditorAction): BoardState {
  switch (action.type) {
    case 'change': {
      const next = applyBoardAction(state.history.present, action.action)
      const history = commit(state.history, next, action.key)
      const selection = action.select ?? state.selection
      if (history === state.history && selection === state.selection) return state
      return { history, selection: prune(selection, history.present) }
    }
    case 'undo':
    case 'redo': {
      const history = action.type === 'undo' ? undo(state.history) : redo(state.history)
      if (history === state.history) return state
      return { history, selection: prune(state.selection, history.present) }
    }
    case 'select':
      return { ...state, selection: prune(action.ids, state.history.present) }
    case 'toggleSelect': {
      const current = new Set(state.selection)
      for (const id of action.ids) {
        if (current.has(id)) current.delete(id)
        else current.add(id)
      }
      return { ...state, selection: prune([...current], state.history.present) }
    }
    case 'load':
      return initBoard(action.document)
    case 'adopt':
      if (state.history.present !== action.from) return state
      return { history: { ...state.history, present: action.document }, selection: prune(state.selection, action.document) }
  }
}
