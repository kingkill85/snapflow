import { describe, expect, it } from 'vitest'

import type { PlanNeed, PlanZone } from '@/api/generated/model'

import { functionTypes, loadTypes, needCatalog, pid, placement, roomTemplate } from '../test-fixtures'
import { applyDocumentAction, type PlanDocument, toContentInput } from './document'
import { editorReducer, initEditor } from './editor-state'
import { allVisible, visibleIds } from './layers'
import { allowedLoadTypes, applyTemplate, functionTypePatch, needCounts, needText, needZoneId, newNeed, symbolIcon, symbolLetter } from './needs'
import { clampMove } from './placements'
import { saveErrorsByItem, selectionFor } from './save-errors'
import { ApiError } from '@/api/client'

const zone = (n: number, x0: number): PlanZone => ({
  id: pid(950 + n),
  name: `Zone ${n}`,
  color: '#3b82f6',
  opacity: 0.25,
  points: [
    [x0, 0],
    [x0 + 150, 0],
    [x0 + 150, 300],
    [x0, 300],
  ],
})
const zones = [zone(1, 0), zone(2, 150)]
const need = (n: number, over: Partial<PlanNeed> = {}): PlanNeed => ({ ...newNeed(functionTypes[0].id, zones[0].id), id: pid(1300 + n), ...over })
const symbol = (n: number, x: number, y: number) => need(n, { x, y, zoneId: null })
const doc = (needs: PlanNeed[]): PlanDocument => ({ scale: null, zones, placements: [placement(1)], needs })

describe('needs in the plan document', () => {
  it('adds, updates, reorders and removes needs; a removed zone takes its needs along, not its symbols', () => {
    let d = doc([])
    d = applyDocumentAction(d, { type: 'addNeeds', needs: [need(1), need(2), need(3, { zoneId: zones[1].id }), symbol(4, 50, 50)] })
    expect(d.needs.map((n) => n.id)).toEqual([pid(1301), pid(1302), pid(1303), pid(1304)])
    expect(applyDocumentAction(d, { type: 'updateNeeds', changes: [{ id: pid(1301), patch: { quantity: 1 } }] })).toBe(d)
    d = applyDocumentAction(d, { type: 'updateNeeds', changes: [{ id: pid(1301), patch: { quantity: 3, label: 'Ceiling' } }] })
    expect(d.needs[0]).toMatchObject({ quantity: 3, label: 'Ceiling' })

    // Reorder within the zone: the two needs swap their places, the others stay.
    d = applyDocumentAction(d, { type: 'reorderNeeds', ids: [pid(1302), pid(1301)] })
    expect(d.needs.map((n) => n.id)).toEqual([pid(1302), pid(1301), pid(1303), pid(1304)])
    expect(applyDocumentAction(d, { type: 'reorderNeeds', ids: [pid(1302), pid(1301)] })).toBe(d)

    const removed = applyDocumentAction(d, { type: 'remove', ids: [zones[0].id] })
    expect(removed.needs.map((n) => n.id)).toEqual([pid(1303), pid(1304)])
    expect(applyDocumentAction(d, { type: 'remove', ids: [pid(1303)] }).needs).toHaveLength(3)
  })

  it('moves load symbols with the selection and keeps them inside the image', () => {
    const d = doc([symbol(1, 50, 50), need(2)])
    const moved = applyDocumentAction(d, { type: 'moveBy', ids: [pid(1301), pid(1302)], dx: 10, dy: 5 })
    expect(moved.needs[0]).toMatchObject({ x: 60, y: 55 })
    expect(moved.needs[1]).toBe(d.needs[1])
    expect(clampMove(d, [pid(1301)], -100, 0, { width: 1000, height: 800 })).toEqual({ dx: -50, dy: 0 })
  })

  it('always sends the needs', () => {
    expect(toContentInput(doc([]), 'at')).toHaveProperty('needs', [])
    expect(toContentInput(doc([need(1)]), 'at').needs).toHaveLength(1)
  })

  it('applies a template as one undo step and selects symbols like other items', () => {
    let state = initEditor(doc([]))
    const { needs, skipped } = applyTemplate(roomTemplate(1), zones[0].id, needCatalog.functionTypeById, needCatalog.loadTypeById)
    expect(skipped).toBe(1)
    expect(needs).toEqual([
      expect.objectContaining({ zoneId: zones[0].id, functionTypeId: functionTypes[0].id, quantity: 3, powerW: 7.5, loadTypeId: loadTypes[0].id, label: 'Ceiling', x: null }),
      expect.objectContaining({ functionTypeId: functionTypes[1].id, quantity: 2 }),
    ])
    state = editorReducer(state, { type: 'change', action: { type: 'addNeeds', needs } })
    state = editorReducer(state, { type: 'change', action: { type: 'updateNeeds', changes: [{ id: needs[0].id, patch: { label: 'C' } }] }, key: `${needs[0].id}:label` })
    state = editorReducer(state, { type: 'change', action: { type: 'updateNeeds', changes: [{ id: needs[0].id, patch: { label: 'Co' } }] }, key: `${needs[0].id}:label` })
    state = editorReducer(state, { type: 'undo' })
    expect(state.history.present.needs[0].label).toBe('Ceiling')
    state = editorReducer(state, { type: 'undo' })
    expect(state.history.present.needs).toHaveLength(0)
    state = editorReducer(state, { type: 'redo' })
    expect(state.history.present.needs).toHaveLength(2)

    state = editorReducer(state, { type: 'change', action: { type: 'addNeeds', needs: [symbol(9, 10, 10)] }, select: [pid(1309)] })
    expect(state.selection).toEqual([pid(1309)])
    // A need without position is not selectable on the plan.
    state = editorReducer(state, { type: 'select', ids: [needs[0].id, pid(1309)] })
    expect(state.selection).toEqual([pid(1309)])
    state = editorReducer(state, { type: 'undo' })
    expect(state.selection).toEqual([])
  })

  it('a batch is one step', () => {
    let state = initEditor(doc([]))
    state = editorReducer(state, { type: 'change', action: { type: 'batch', actions: [{ type: 'addPlacements', placements: [placement(2)] }, { type: 'addNeeds', needs: [symbol(1, 5, 5)] }] } })
    expect(state.history.present.needs).toHaveLength(1)
    state = editorReducer(state, { type: 'undo' })
    expect(state.history.present.needs).toHaveLength(0)
    expect(state.history.present.placements).toHaveLength(1)
  })
})

describe('need helpers', () => {
  const localize = (t: Record<string, string> | undefined) => t?.en ?? ''
  it('says a need in plain words', () => {
    const text = (n: PlanNeed) => needText(n, needCatalog.functionTypeById, needCatalog.loadTypeById, localize, String, 'Unknown')
    expect(text(need(1, { quantity: 3, powerW: 60, loadTypeId: loadTypes[0].id, label: 'Ceiling' }))).toBe('3 × Dimmable light · 60 W · LED · Ceiling')
    expect(text(need(1))).toBe('Dimmable light')
    expect(text(need(1, { functionTypeId: 'gone' }))).toBe('Unknown')
  })

  it('filters load types by the function type and drops a load type the new function does not allow', () => {
    expect(allowedLoadTypes(functionTypes[0], loadTypes).map((l) => l.id)).toEqual([loadTypes[0].id])
    expect(allowedLoadTypes(functionTypes[1], loadTypes)).toHaveLength(2)
    expect(functionTypePatch({ loadTypeId: loadTypes[1].id }, functionTypes[0])).toEqual({ functionTypeId: functionTypes[0].id, loadTypeId: null })
    expect(functionTypePatch({ loadTypeId: loadTypes[1].id }, functionTypes[1])).toEqual({ functionTypeId: functionTypes[1].id })
  })

  it('counts units per zone with symbols where they lie', () => {
    const needs = [need(1, { quantity: 3 }), symbol(2, 200, 100), symbol(3, 900, 700)]
    expect(needZoneId(needs[1], zones)).toBe(zones[1].id)
    const counts = needCounts(needs, zones)
    expect(counts.get(zones[0].id)).toBe(3)
    expect(counts.get(zones[1].id)).toBe(1)
    expect(counts.get(null)).toBe(1)
  })

  it('picks pictograms by key, else the first letter', () => {
    expect(symbolIcon('dimmable_light')).toBe('dimmer')
    expect(symbolIcon('switched_light')).toBe('lamp')
    expect(symbolIcon('roller_blind')).toBe('blind')
    expect(symbolIcon('socket_outlet')).toBe('socket')
    expect(symbolIcon('pushbutton')).toBe('pushbutton')
    expect(symbolIcon('heating')).toBeUndefined()
    expect(symbolLetter('heating valve')).toBe('H')
  })

  it('maps need errors to the need, selected through its zone or as a symbol', () => {
    const d = doc([need(1), symbol(2, 10, 10)])
    const error = new ApiError({ status: 422, code: 'validation.failed', fields: [{ location: 'body.needs[1].quantity', code: 'validation.range', params: {} }] })
    const byItem = saveErrorsByItem(error, d, (f) => f.code)
    expect([...byItem.keys()]).toEqual([pid(1302)])
    expect(selectionFor(pid(1302), d)).toBe(pid(1302))
    expect(selectionFor(pid(1301), d)).toBe(zones[0].id)
  })

  it('lists visible symbols for select-all unless the needs layer is hidden', () => {
    const d = doc([need(1), symbol(2, 10, 10)])
    expect(visibleIds(d, allVisible(), new Map())).toEqual([zones[0].id, zones[1].id, placement(1).id, pid(1302)])
    expect(visibleIds(d, { ...allVisible(), needsHidden: true }, new Map())).not.toContain(pid(1302))
  })
})
