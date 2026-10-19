import type { PlanPlacement, PlanZone } from '@/api/generated/model'
import { boundsOf, clamp, type Point, type Rect, type Size } from '@/canvas'

import { newId } from './document'

// Zone geometry and helpers (step 2b part B). Points are [x, y] in image pixels.

/** The colours offered for zones; new zones take the next one in turn. */
export const zoneColors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#84cc16'] as const

/** The default fill opacity of a new zone. */
export const defaultZoneOpacity = 0.25

/** The fewest corners a zone keeps. */
export const minZonePoints = 3

export const toPoint = ([x, y]: number[]): Point => ({ x, y })
export const toPair = (p: Point): number[] => [round(p.x), round(p.y)]
const round = (n: number) => Math.round(n * 10) / 10

/** Area of a polygon (shoelace), always ≥ 0. */
export function polygonArea(points: number[][]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

/** Whether p lies on the segment a-b (tiny tolerance for floating point); as `onSegment` in the backend's geometry.go. */
function onSegment(p: Point, a: number[], b: number[]): boolean {
  const eps = 1e-9
  const cross = (b[0] - a[0]) * (p.y - a[1]) - (b[1] - a[1]) * (p.x - a[0])
  const scale = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))
  if (Math.abs(cross) > eps * scale) return false
  return (
    p.x >= Math.min(a[0], b[0]) - eps &&
    p.x <= Math.max(a[0], b[0]) + eps &&
    p.y >= Math.min(a[1], b[1]) - eps &&
    p.y <= Math.max(a[1], b[1]) + eps
  )
}

/**
 * Whether the point is inside the polygon or on its boundary: an exact port of
 * the backend's `contains` (ray casting; a point on an edge or a corner counts
 * as inside, so a device on a wall line belongs to the room).
 */
export function pointInPolygon(p: Point, points: number[][]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (onSegment(p, a, b)) return true
    if (a[1] > p.y !== b[1] > p.y) {
      const x = ((b[0] - a[0]) * (p.y - a[1])) / (b[1] - a[1]) + a[0]
      if (p.x < x) inside = !inside
    }
  }
  return inside
}

/**
 * The zone a point belongs to, as the backend's `zoneOf`: the smallest
 * containing polygon by area; of equal areas the zone drawn last wins.
 */
export function zoneAt(p: Point, zones: PlanZone[]): PlanZone | undefined {
  let best: PlanZone | undefined
  let bestArea = Infinity
  for (const z of zones) {
    if (!pointInPolygon(p, z.points)) continue
    const area = polygonArea(z.points)
    if (best === undefined || area <= bestArea) {
      best = z
      bestArea = area
    }
  }
  return best
}

/** Placements per zone id: as last saved (the backend's `zoneId`) and estimated now with the same rule. */
export function zoneCounts(saved: PlanPlacement[], current: PlanPlacement[], zones: PlanZone[]) {
  const savedCounts = new Map<string, number>()
  for (const p of saved) if (p.zoneId) savedCounts.set(p.zoneId, (savedCounts.get(p.zoneId) ?? 0) + 1)
  const estimate = new Map<string, number>()
  for (const p of current) {
    const z = zoneAt(p, zones)
    if (z) estimate.set(z.id, (estimate.get(z.id) ?? 0) + 1)
  }
  return { saved: savedCounts, estimate }
}

/** "Zone n" with the lowest free number: the smallest n ≥ 1 not used by a zone named "<prefix> n" (D205). */
export function nextZoneName(zones: PlanZone[], prefix: string): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`)
  const used = new Set(zones.flatMap((z) => (pattern.exec(z.name.trim()) ? [Number(pattern.exec(z.name.trim())?.[1])] : [])))
  let n = 1
  while (used.has(n)) n++
  return `${prefix} ${n}`
}

/** The colour after the last zone's in the palette (the first for the first zone). */
export function nextZoneColor(zones: PlanZone[]): string {
  const last = zones.at(-1)?.color.toLowerCase()
  const i = zoneColors.findIndex((c) => c === last)
  return zoneColors[(i + 1) % zoneColors.length] ?? zoneColors[0]
}

/** A new zone with the given corners. */
export function newZone(points: Point[], zones: PlanZone[], prefix: string): PlanZone {
  return { id: newId(), name: nextZoneName(zones, prefix), color: nextZoneColor(zones), opacity: defaultZoneOpacity, points: points.map(toPair) }
}

/** The four corners of a rectangle, clockwise from the top left. */
export const rectCorners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height },
  { x: r.x, y: r.y + r.height },
]

/** Keeps a point inside the image. */
export const clampToImage = (p: Point, size: { width: number; height: number }): Point => ({
  x: Math.min(size.width, Math.max(0, p.x)),
  y: Math.min(size.height, Math.max(0, p.y)),
})

/** The corners with one moved. */
export const moveVertex = (points: number[][], index: number, to: Point): number[][] => points.map((p, i) => (i === index ? toPair(to) : p))

/** The corners with a new one after `index` (on the edge to the next corner). */
export const insertVertex = (points: number[][], index: number, at: Point): number[][] => [...points.slice(0, index + 1), toPair(at), ...points.slice(index + 1)]

/** The corners without one; unchanged when only the minimum is left. */
export const removeVertex = (points: number[][], index: number): number[][] =>
  points.length <= minZonePoints ? points : points.filter((_, i) => i !== index)

/** The midpoints of every edge (handles to add a corner): edge i runs from corner i to i + 1. */
export const edgeMidpoints = (points: number[][]): Point[] =>
  points.map((p, i) => {
    const q = points[(i + 1) % points.length]
    return { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 }
  })

/** The bounding box of a zone. */
export const zoneBounds = (z: PlanZone): Rect => boundsOf(z.points.map(toPoint))

/** Where a zone's name is drawn: the centre of its bounds. */
export function labelPoint(z: PlanZone): Point {
  const b = zoneBounds(z)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** A polygon being drawn can close: at least 3 distinct corners with an area. */
export const canClose = (points: Point[]) => points.length >= minZonePoints && polygonArea(points.map(toPair)) > 0

/** A handle of the frame around one selected zone: corners scale, sides stretch (D252). */
export type FrameHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const frameHandles: FrameHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The smallest width and height a frame resize leaves a zone, in image pixels (a smaller zone keeps its size). */
export const minZoneSize = 10

/**
 * A zone resized as a whole by dragging a handle of its bounding box by
 * `delta` (D252): the opposite corner or side stays. A corner scales
 * proportionally (`free`: width and height independently), a side stretches
 * one axis. Never below `minZoneSize` per axis (no flipping) and the bounds
 * stay inside the image (D213).
 */
export function scaleZone(points: number[][], handle: FrameHandle, delta: Point, free: boolean, image: Size): number[][] {
  const b = boundsOf(points.map(toPoint))
  // Per axis: the moving edge's direction (+1 right/bottom, -1 left/top, 0 none), the anchor and the allowed scale range.
  const axis = (dir: number, start: number, size: number, d: number, limit: number) => {
    if (dir === 0 || size === 0) return { anchor: start, scale: 1, min: 0, max: Infinity, active: false }
    const anchor = dir > 0 ? start : start + size
    const room = dir > 0 ? limit - anchor : anchor
    const min = Math.min(minZoneSize, size) / size
    const max = Math.max(room, size) / size
    return { anchor, scale: (size + dir * d) / size, min, max, active: true }
  }
  const x = axis(handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0, b.x, b.width, delta.x, image.width)
  const y = axis(handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0, b.y, b.height, delta.y, image.height)
  let sx = clamp(x.scale, x.min, x.max)
  let sy = clamp(y.scale, y.min, y.max)
  if (x.active && y.active && !free) {
    // Proportional: the axis that changed more leads, limited by both axes' ranges.
    const s = Math.abs(x.scale - 1) >= Math.abs(y.scale - 1) ? x.scale : y.scale
    sx = sy = clamp(s, Math.max(x.min, y.min), Math.min(x.max, y.max))
  }
  return points.map(([px, py]) => toPair({ x: x.anchor + (px - x.anchor) * sx, y: y.anchor + (py - y.anchor) * sy }))
}
