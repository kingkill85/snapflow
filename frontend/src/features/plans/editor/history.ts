/** Undo/redo history of immutable states (D199). */
export type History<T> = {
  past: T[]
  present: T
  future: T[]
  /** The coalescing key of the last step: a following step with the same key replaces it (typing into a field). */
  lastKey?: string
}

/** Steps kept for undo (the spec asks for at least 100). */
export const historyLimit = 200

export const initHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] })

/**
 * Records `next` as a new step. The same state is no step. With `key`, a step
 * right after another with the same key merges into it.
 */
export function commit<T>(h: History<T>, next: T, key?: string): History<T> {
  if (next === h.present) return h
  if (key !== undefined && key === h.lastKey && h.past.length > 0) {
    return { past: h.past, present: next, future: [], lastKey: key }
  }
  const past = [...h.past, h.present]
  if (past.length > historyLimit) past.splice(0, past.length - historyLimit)
  return { past, present: next, future: [], lastKey: key }
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h
  const previous = h.past[h.past.length - 1]
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] }
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h
  const [next, ...future] = h.future
  return { past: [...h.past, h.present], present: next, future }
}

export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0
