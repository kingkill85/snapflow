import { describe, expect, it } from 'vitest'

import type { PlanZone } from '@/api/generated/model'

import { placement } from '../test-fixtures'
import {
  canClose,
  edgeMidpoints,
  insertVertex,
  moveVertex,
  nextZoneColor,
  nextZoneName,
  pointInPolygon,
  polygonArea,
  removeVertex,
  zoneAt,
  zoneColors,
  zoneCounts,
} from './zones'

const square = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
]
const zone = (id: string, points: number[][], over: Partial<PlanZone> = {}): PlanZone => ({ id, name: id, color: '#3b82f6', opacity: 0.25, points, ...over })

describe('zone geometry', () => {
  it('computes the area regardless of orientation', () => {
    expect(polygonArea(square(0, 0, 10))).toBe(100)
    expect(polygonArea([...square(0, 0, 10)].reverse())).toBe(100)
    expect(polygonArea([[0, 0], [5, 5], [10, 10]])).toBe(0)
  })

  it('tests points inside a polygon by ray casting', () => {
    const triangle = [[0, 0], [10, 0], [0, 10]]
    expect(pointInPolygon({ x: 2, y: 2 }, triangle)).toBe(true)
    expect(pointInPolygon({ x: 8, y: 8 }, triangle)).toBe(false)
    expect(pointInPolygon({ x: -1, y: 5 }, triangle)).toBe(false)
  })

  it('assigns a point to the smallest containing zone', () => {
    const outer = zone('outer', square(0, 0, 100))
    const inner = zone('inner', square(10, 10, 20))
    expect(zoneAt({ x: 15, y: 15 }, [outer, inner])?.id).toBe('inner')
    expect(zoneAt({ x: 15, y: 15 }, [inner, outer])?.id).toBe('inner')
    expect(zoneAt({ x: 50, y: 50 }, [outer, inner])?.id).toBe('outer')
    expect(zoneAt({ x: 500, y: 50 }, [outer, inner])).toBeUndefined()
  })

  it('counts placements per zone as saved and as estimated now', () => {
    const zones = [zone('a', square(0, 0, 150)), zone('b', square(150, 0, 500))]
    const saved = [placement(1, { zoneId: 'a' }), placement(2, { zoneId: 'a' }), placement(3, { zoneId: null })]
    // Now: x = 100 (a), 200 (b), 300 (b)
    const current = [placement(1), placement(2), placement(3)]
    const { saved: s, estimate } = zoneCounts(saved, current, zones)
    expect(s.get('a')).toBe(2)
    expect(s.get('b')).toBeUndefined()
    expect(estimate.get('a')).toBe(1)
    expect(estimate.get('b')).toBe(2)
  })
})

describe('new zones', () => {
  it('names a zone with the next free number', () => {
    expect(nextZoneName([], 'Zone')).toBe('Zone 1')
    expect(nextZoneName([zone('1', [], { name: 'Zone 1' }), zone('3', [], { name: 'Zone 3' })], 'Zone')).toBe('Zone 2')
    expect(nextZoneName([zone('k', [], { name: 'Kitchen' }), zone('1', [], { name: 'Zone 1' })], 'Zone')).toBe('Zone 2')
    expect(nextZoneName([zone('x', [], { name: 'Zone one' })], 'Zone')).toBe('Zone 1')
  })

  it('takes the next palette colour after the last zone and cycles', () => {
    expect(nextZoneColor([])).toBe(zoneColors[0])
    expect(nextZoneColor([zone('a', [], { color: zoneColors[0] })])).toBe(zoneColors[1])
    expect(nextZoneColor([zone('a', [], { color: zoneColors.at(-1) })])).toBe(zoneColors[0])
    expect(nextZoneColor([zone('a', [], { color: '#123456' })])).toBe(zoneColors[0])
  })
})

describe('vertex editing', () => {
  const pts = square(0, 0, 10)

  it('moves, inserts and removes corners', () => {
    expect(moveVertex(pts, 1, { x: 20, y: 1 })[1]).toEqual([20, 1])
    const inserted = insertVertex(pts, 0, { x: 5, y: 0 })
    expect(inserted).toHaveLength(5)
    expect(inserted[1]).toEqual([5, 0])
    expect(inserted[2]).toEqual([10, 0])
    expect(removeVertex(pts, 0)).toEqual([[10, 0], [10, 10], [0, 10]])
  })

  it('keeps at least three corners', () => {
    const triangle = [[0, 0], [10, 0], [0, 10]]
    expect(removeVertex(triangle, 1)).toBe(triangle)
  })

  it('gives the midpoint of every edge, the last one closing the polygon', () => {
    expect(edgeMidpoints(pts)).toEqual([
      { x: 5, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 5 },
    ])
  })

  it('closes a drawn polygon only with three corners and an area', () => {
    expect(canClose([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(false)
    expect(canClose([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(false)
    expect(canClose([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }])).toBe(true)
  })
})
