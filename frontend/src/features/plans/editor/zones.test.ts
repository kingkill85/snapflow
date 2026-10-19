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
  scaleZone,
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

  it('decides membership exactly as the backend (cases of geometry_test.go)', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const concave = [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]] // a notch at the top
    const cases: [number[][], number, number, boolean][] = [
      [sq, 5, 5, true],
      [sq, 0, 0, true], // vertex
      [sq, 10, 3, true], // edge
      [sq, 10.001, 3, false],
      [sq, -1, 5, false],
      [concave, 5, 8, false], // in the notch
      [concave, 5, 3, true],
      [concave, 7.5, 7.5, true], // on the notch edge
    ]
    for (const [points, x, y, want] of cases) expect(pointInPolygon({ x, y }, points), `${x},${y}`).toBe(want)
  })

  it('gives equal areas to the zone drawn last, as the backend', () => {
        const big = zone('big', [[0, 0], [100, 0], [100, 100], [0, 100]])
    const small = zone('small', [[10, 10], [20, 10], [20, 20], [10, 20]])
    const same = zone('same', [[10, 10], [20, 10], [20, 20], [10, 20]])
    expect(zoneAt({ x: 15, y: 15 }, [small, big, same])?.id).toBe('same')
    expect(zoneAt({ x: 50, y: 50 }, [small, big, same])?.id).toBe('big')
    // On the shared wall of two rooms: the later one.
    const left = zone('left', [[0, 0], [10, 0], [10, 10], [0, 10]])
    const right = zone('right', [[10, 0], [20, 0], [20, 10], [10, 10]])
    expect(zoneAt({ x: 10, y: 5 }, [left, right])?.id).toBe('right')
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

describe('scaleZone (resize a zone as a whole, D252)', () => {
  const image = { width: 1000, height: 800 }
  const rect = square(100, 100, 200) // 100..300 both ways
  const triangle = [
    [100, 100],
    [300, 100],
    [100, 200],
  ]

  it('scales proportionally around the opposite corner', () => {
    expect(scaleZone(rect, 'se', { x: 100, y: 20 }, false, image)).toEqual(square(100, 100, 300))
  })

  it('scales a triangle around the opposite corner of its bounds', () => {
    // Bounds 100..300 x 100..200; dragging nw by -20 x shrinks... grows by 1.1 around (300, 200).
    expect(scaleZone(triangle, 'nw', { x: -20, y: 0 }, false, image)).toEqual([
      [80, 90],
      [300, 90],
      [80, 200],
    ])
  })

  it('scales width and height independently when free (Shift)', () => {
    expect(scaleZone(rect, 'se', { x: 100, y: 20 }, true, image)).toEqual([
      [100, 100],
      [400, 100],
      [400, 320],
      [100, 320],
    ])
    expect(scaleZone(rect, 'ne', { x: -100, y: -50 }, true, image)).toEqual([
      [100, 50],
      [200, 50],
      [200, 300],
      [100, 300],
    ])
  })

  it('stretches one axis around the opposite side', () => {
    expect(scaleZone(rect, 'e', { x: 50, y: 999 }, false, image)).toEqual([
      [100, 100],
      [350, 100],
      [350, 300],
      [100, 300],
    ])
    expect(scaleZone(rect, 'n', { x: 999, y: -40 }, false, image)).toEqual([
      [100, 60],
      [300, 60],
      [300, 300],
      [100, 300],
    ])
  })

  it('keeps a minimum size and never flips', () => {
    expect(scaleZone(rect, 'w', { x: 500, y: 0 }, false, image)).toEqual([
      [290, 100],
      [300, 100],
      [300, 300],
      [290, 300],
    ])
    expect(scaleZone(rect, 'se', { x: -400, y: -400 }, false, image)).toEqual(square(100, 100, 10))
    // A zone already smaller than the minimum is not grown by shrinking it.
    expect(scaleZone(square(10, 10, 4), 'e', { x: -10, y: 0 }, false, image)).toEqual(square(10, 10, 4))
  })

  it('stays inside the image', () => {
    expect(scaleZone(rect, 'e', { x: 5000, y: 0 }, false, image)).toEqual([
      [100, 100],
      [1000, 100],
      [1000, 300],
      [100, 300],
    ])
    // Proportional: limited by the axis that reaches the edge first (here the top at 0).
    expect(scaleZone(rect, 'nw', { x: -500, y: -500 }, false, image)).toEqual([
      [0, 0],
      [300, 0],
      [300, 300],
      [0, 300],
    ])
    expect(scaleZone(rect, 'sw', { x: 0, y: 5000 }, true, image)).toEqual([
      [100, 100],
      [300, 100],
      [300, 800],
      [100, 800],
    ])
  })
})
