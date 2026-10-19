import { describe, expect, it } from 'vitest'

import type { PlanZone } from '@/api/generated/model'

import { catalog, placement, pid } from '../test-fixtures'
import { parseMetres, scaleBar, scaleFrom } from './calibration'
import { documentOf } from './document'
import { editorReducer, initEditor } from './editor-state'
import { exportFileName } from './export'
import { canUndo, undo } from './history'
import { allVisible, placementVisible, visibleIds, zoneVisible } from './layers'
import { resizeChanges } from './placements'

const variants = new Map(catalog.map((v) => [v.id, v]))
const zone = (id: string): PlanZone => ({ id, name: id, color: '#3b82f6', opacity: 0.25, points: [[0, 0], [10, 0], [0, 10]] })

describe('calibration', () => {
  it('computes metres per pixel from two points and a distance', () => {
    expect(scaleFrom({ x: 0, y: 0 }, { x: 300, y: 400 }, 5)).toBe(0.01)
    expect(scaleFrom({ x: 0, y: 0 }, { x: 0, y: 0 }, 5)).toBeUndefined()
    expect(scaleFrom({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toBeUndefined()
  })

  it('reads metres with either decimal separator', () => {
    expect(parseMetres('3,5')).toBe(3.5)
    expect(parseMetres(' 3.5 ')).toBe(3.5)
    expect(parseMetres('0')).toBeUndefined()
    expect(parseMetres('abc')).toBeUndefined()
    expect(parseMetres('-2')).toBeUndefined()
  })

  it('picks a round scale bar length that fits', () => {
    // 0.01 m per px at zoom 1: 120 px = 1.2 m → 1 m, 100 px.
    expect(scaleBar(0.01, 1)).toEqual({ metres: 1, px: 100 })
    // At zoom 2: 120 px = 0.6 m → 0.5 m, 100 px.
    const zoomed = scaleBar(0.01, 2)!
    expect(zoomed.metres).toBeCloseTo(0.5)
    expect(zoomed.px).toBeCloseTo(100)
    // 0.05 m per px: 120 px = 6 m → 5 m.
    expect(scaleBar(0.05, 1)?.metres).toBe(5)
    // 0.02 m per px: 2.4 m → 2 m.
    expect(scaleBar(0.02, 1)?.metres).toBe(2)
    expect(scaleBar(0, 1)).toBeUndefined()
  })
})

describe('layers', () => {
  const switchPlacement = placement(1, { variantId: catalog[0].id })
  const sensorPlacement = placement(2, { variantId: catalog[2].id })
  const deleted = placement(3, { variantId: null })

  it('hides placements by product type and category; deleted variants stay visible', () => {
    const byType = { ...allVisible(), hiddenProductTypes: new Set([catalog[0].productTypeId]) }
    expect(placementVisible(switchPlacement, byType, variants)).toBe(false)
    expect(placementVisible(deleted, byType, variants)).toBe(true)
    const byCategory = { ...allVisible(), hiddenCategories: new Set([catalog[2].categoryId]) }
    expect(placementVisible(switchPlacement, byCategory, variants)).toBe(true)
    expect(placementVisible(sensorPlacement, byCategory, variants)).toBe(false)
  })

  it('hides zones all at once or one by one', () => {
    expect(zoneVisible(zone('a'), allVisible())).toBe(true)
    expect(zoneVisible(zone('a'), { ...allVisible(), zonesHidden: true })).toBe(false)
    expect(zoneVisible(zone('a'), { ...allVisible(), hiddenZones: new Set(['a']) })).toBe(false)
    expect(zoneVisible(zone('b'), { ...allVisible(), hiddenZones: new Set(['a']) })).toBe(true)
  })

  it('lists the visible ids for select-all', () => {
    const doc = { placements: [switchPlacement, sensorPlacement], zones: [zone('a'), zone('b')] }
    const layers = { ...allVisible(), hiddenCategories: new Set([catalog[2].categoryId]), hiddenZones: new Set(['b']) }
    expect(visibleIds(doc, layers, variants)).toEqual(['a', switchPlacement.id])
  })
})

describe('export file name', () => {
  it('joins project number and plan name and strips what file systems refuse', () => {
    expect(exportFileName('2026-001', 'Ground floor')).toBe('2026-001 Ground floor.png')
    expect(exportFileName('P1', 'a/b:c*d?e')).toBe('P1 a-b-c-d-e.png')
    expect(exportFileName('P1', 'x\u0001\ny')).toBe('P1 x y.png')
    expect(exportFileName('', '')).toBe('plan.png')
  })
})

describe('resize all of this product', () => {
  // Variants 1 and 2 are the same product (wall switch); 3 is a sensor.
  const a = placement(1, { variantId: catalog[0].id })
  const b = placement(2, { variantId: catalog[1].id })
  const c = placement(3, { variantId: catalog[2].id })
  const placements = [a, b, c]

  it('changes only the placement when off', () => {
    expect(resizeChanges(placements, a.id, { width: 80 }, variants, false)).toEqual([{ id: a.id, patch: { width: 80 } }])
  })

  it('applies the size to every placement of the same product when on, not position or others', () => {
    const changes = resizeChanges(placements, a.id, { x: 5, y: 6, width: 80, height: 90 }, variants, true)
    expect(changes).toEqual([
      { id: a.id, patch: { x: 5, y: 6, width: 80, height: 90 } },
      { id: b.id, patch: { width: 80, height: 90 } },
    ])
  })

  it('is one undo step', () => {
    let state = initEditor(documentOf({ planId: pid(501), contentUpdatedAt: '', scale: null, zones: [], placements, warnings: [] }))
    state = editorReducer(state, { type: 'change', action: { type: 'updatePlacements', changes: resizeChanges(placements, a.id, { width: 80 }, variants, true) } })
    expect(state.history.present.placements.map((p) => p.width)).toEqual([80, 80, 60])
    const back = undo(state.history)
    expect(back.present.placements.map((p) => p.width)).toEqual([60, 60, 60])
    expect(canUndo(back)).toBe(false)
  })
})
