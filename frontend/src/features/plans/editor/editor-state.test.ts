import { describe, expect, it } from 'vitest'

import { placement } from '../test-fixtures'
import { applyDocumentAction, type PlanDocument, toContentInput } from './document'
import { editorReducer, initEditor } from './editor-state'
import { canRedo, canUndo, commit, historyLimit, initHistory, redo, undo } from './history'

const doc = (n = 2): PlanDocument => ({ scale: null, zones: [], placements: Array.from({ length: n }, (_, i) => placement(i + 1)), needs: [] })

describe('plan document', () => {
  it('returns the same document when nothing changes', () => {
    const d = doc()
    expect(applyDocumentAction(d, { type: 'updatePlacements', changes: [{ id: d.placements[0].id, patch: { x: 100 } }] })).toBe(d)
    expect(applyDocumentAction(d, { type: 'moveBy', ids: [d.placements[0].id], dx: 0, dy: 0 })).toBe(d)
    expect(applyDocumentAction(d, { type: 'remove', ids: ['nope'] })).toBe(d)
  })

  it('normalises rotations and moves items', () => {
    const d = doc()
    const rotated = applyDocumentAction(d, { type: 'updatePlacements', changes: [{ id: d.placements[0].id, patch: { rotation: 370 } }] })
    expect(rotated.placements[0].rotation).toBe(10)
    const moved = applyDocumentAction(d, { type: 'moveBy', ids: [d.placements[1].id], dx: 5, dy: -5 })
    expect(moved.placements[1]).toMatchObject({ x: 205, y: 95 })
    expect(moved.placements[0]).toBe(d.placements[0])
  })

  it('sends placements without the computed zone', () => {
    const body = toContentInput({ ...doc(1), placements: [placement(1, { zoneId: 'z' })] }, 'at')
    expect(body.placements[0]).not.toHaveProperty('zoneId')
    expect(body.expectedContentUpdatedAt).toBe('at')
  })
})

describe('history', () => {
  it('undoes and redoes, and a new step drops the redo branch', () => {
    let h = initHistory(1)
    h = commit(h, 2)
    h = commit(h, 3)
    h = undo(h)
    expect(h.present).toBe(2)
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.present).toBe(3)
    h = undo(undo(h))
    h = commit(h, 4)
    expect(h.present).toBe(4)
    expect(canRedo(h)).toBe(false)
    expect(undo(h).present).toBe(1)
  })

  it('keeps at least 100 steps', () => {
    let h = initHistory(0)
    for (let i = 1; i <= 300; i++) h = commit(h, i)
    expect(h.past).toHaveLength(historyLimit)
    expect(historyLimit).toBeGreaterThanOrEqual(100)
    for (let i = 0; i < 150; i++) h = undo(h)
    expect(h.present).toBe(150)
  })

  it('merges consecutive steps with the same key', () => {
    let h = initHistory('')
    h = commit(h, 'a', 'label')
    h = commit(h, 'ab', 'label')
    h = commit(h, 'abc', 'label')
    expect(h.past).toEqual([''])
    h = commit(h, 'x', 'other')
    expect(h.past).toEqual(['', 'abc'])
    expect(canUndo(h)).toBe(true)
  })
})

describe('editor state', () => {
  it('keeps the selection out of the history but drops ids that disappear', () => {
    const d = doc()
    let s = initEditor(d)
    const added = placement(9)
    s = editorReducer(s, { type: 'change', action: { type: 'addPlacements', placements: [added] }, select: [added.id] })
    expect(s.selection).toEqual([added.id])
    s = editorReducer(s, { type: 'select', ids: [d.placements[0].id, added.id] })
    expect(s.history.past).toHaveLength(1)
    s = editorReducer(s, { type: 'undo' })
    expect(s.selection).toEqual([d.placements[0].id])
    s = editorReducer(s, { type: 'redo' })
    expect(s.history.present.placements).toHaveLength(3)
    expect(s.selection).toEqual([d.placements[0].id])
  })

  it('toggles ids for shift-click and ignores unknown ones', () => {
    const d = doc()
    let s = initEditor(d)
    s = editorReducer(s, { type: 'toggleSelect', ids: [d.placements[0].id, 'unknown'] })
    expect(s.selection).toEqual([d.placements[0].id])
    s = editorReducer(s, { type: 'toggleSelect', ids: [d.placements[0].id, d.placements[1].id] })
    expect(s.selection).toEqual([d.placements[1].id])
  })

  it('makes no step for a change that changes nothing, and load starts over', () => {
    const d = doc()
    const s = initEditor(d)
    expect(editorReducer(s, { type: 'change', action: { type: 'remove', ids: [] } })).toBe(s)
    const changed = editorReducer(s, { type: 'change', action: { type: 'remove', ids: [d.placements[0].id] } })
    const loaded = editorReducer(changed, { type: 'load', document: d })
    expect(loaded.history.past).toEqual([])
    expect(loaded.history.present).toBe(d)
  })
})
