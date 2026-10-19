import type { PlanPlacement, PlanZone } from '@/api/generated/model'
import { boundsOf, type Point, type Rect } from '@/canvas'

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

/** Ray casting: is the point inside the polygon (as the backend decides membership). */
export function pointInPolygon(p: Point, points: number[][]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The zone a point belongs to: the smallest containing polygon (backend rule), else undefined. */
export function zoneAt(p: Point, zones: PlanZone[]): PlanZone | undefined {
  let best: PlanZone | undefined
  let bestArea = Infinity
  for (const z of zones) {
    if (z.points.length < minZonePoints || !pointInPolygon(p, z.points)) continue
    const area = polygonArea(z.points)
    if (area < bestArea) {
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

/** "Zone n" with the next free number (n = 1 + the highest number used by a zone named "<prefix> n"). */
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
