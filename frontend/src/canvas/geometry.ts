// Geometry of the shared canvas (plans of every kind). All document
// coordinates are image pixels; the viewport maps them to screen pixels:
// screen = image * scale + offset.

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
/** An axis-aligned rectangle. */
export type Rect = { x: number; y: number; width: number; height: number }
/** A box by its centre, size and clockwise rotation in degrees (a placement). */
export type Box = { x: number; y: number; width: number; height: number; rotation: number }
/** Image px -> screen px: screen = image * scale + (x, y). */
export type Viewport = { x: number; y: number; scale: number }

export const minZoom = 0.1
export const maxZoom = 8

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const clampZoom = (scale: number) => clamp(scale, minZoom, maxZoom)

export const imageToScreen = (v: Viewport, p: Point): Point => ({ x: p.x * v.scale + v.x, y: p.y * v.scale + v.y })
export const screenToImage = (v: Viewport, p: Point): Point => ({ x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale })

/** Zooms to `scale` (clamped) keeping the image point under `pointer` (screen px) where it is. */
export function zoomAt(v: Viewport, pointer: Point, scale: number): Viewport {
  const next = clampZoom(scale)
  const anchor = screenToImage(v, pointer)
  return { scale: next, x: pointer.x - anchor.x * next, y: pointer.y - anchor.y * next }
}

/** The zoom factor of one wheel event: about 10 % per notch, smooth for trackpads. */
export const wheelFactor = (deltaY: number) => Math.exp(-clamp(deltaY, -100, 100) / 500)

/** The viewport that shows the whole image centred in the stage, with `padding` screen px around it. */
export function fitViewport(image: Size, stage: Size, padding = 16): Viewport {
  if (image.width <= 0 || image.height <= 0 || stage.width <= 0 || stage.height <= 0) return { x: 0, y: 0, scale: 1 }
  const scale = clampZoom(
    Math.min((stage.width - 2 * padding) / image.width, (stage.height - 2 * padding) / image.height),
  )
  return { scale, x: (stage.width - image.width * scale) / 2, y: (stage.height - image.height * scale) / 2 }
}

/** An angle in degrees normalised to [0, 360). */
export function normalizeAngle(degrees: number): number {
  const a = degrees % 360
  const n = a < 0 ? a + 360 : a
  // -0 and floating rest of 360 count as 0.
  return n >= 360 || Object.is(n, -0) ? 0 : n
}

/** Rounds an angle to the nearest multiple of `step` degrees, normalised. */
export const snapAngle = (degrees: number, step = 15) => normalizeAngle(Math.round(degrees / step) * step)

/** `p` rotated by `degrees` (clockwise on screen, y down) around `origin`. */
export function rotatePoint(p: Point, origin: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = p.x - origin.x
  const dy = p.y - origin.y
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos }
}

/** The four corners of a rotated box, clockwise from the top left. */
export function boxCorners(b: Box): Point[] {
  const hw = b.width / 2
  const hh = b.height / 2
  const c = { x: b.x, y: b.y }
  return [
    { x: b.x - hw, y: b.y - hh },
    { x: b.x + hw, y: b.y - hh },
    { x: b.x + hw, y: b.y + hh },
    { x: b.x - hw, y: b.y + hh },
  ].map((p) => rotatePoint(p, c, b.rotation))
}

/** The smallest axis-aligned rectangle around the points. */
export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** The rectangle spanned by two corners in any order (a rubber band). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height

/** Whether `p` lies inside the rotated box (edges included). */
export function pointInBox(p: Point, b: Box): boolean {
  const local = rotatePoint(p, { x: b.x, y: b.y }, -b.rotation)
  return Math.abs(local.x - b.x) <= b.width / 2 + 1e-9 && Math.abs(local.y - b.y) <= b.height / 2 + 1e-9
}

/** The angle in degrees (clockwise, 0 = up) from `centre` to `p`: the rotation a handle above the box gives. */
export function angleTo(centre: Point, p: Point): number {
  return normalizeAngle((Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI + 90)
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw'

/**
 * Resizes a box by dragging one corner to `pointer` (image px); the opposite
 * corner stays put. With `keepAspect` the box keeps its width:height ratio
 * (the larger of both scale factors wins). Sizes stay at least `min`; with
 * `bounds` (the image size) they stay at most its width and height (keeping
 * the aspect ratio when asked) and the centre stays inside it.
 */
export function resizeBox(b: Box, corner: Corner, pointer: Point, keepAspect: boolean, min = 1, bounds?: Size): Box {
  const centre = { x: b.x, y: b.y }
  // Work in the box's own (unrotated) frame.
  const local = rotatePoint(pointer, centre, -b.rotation)
  const sx = corner === 'ne' || corner === 'se' ? 1 : -1
  const sy = corner === 'sw' || corner === 'se' ? 1 : -1
  const anchor = { x: b.x - (sx * b.width) / 2, y: b.y - (sy * b.height) / 2 }
  let width = Math.max(min, (local.x - anchor.x) * sx)
  let height = Math.max(min, (local.y - anchor.y) * sy)
  if (keepAspect && b.width > 0 && b.height > 0) {
    const f = Math.max(width / b.width, height / b.height)
    width = Math.max(min, b.width * f)
    height = Math.max(min, b.height * f)
  }
  if (bounds) {
    if (keepAspect) {
      const f = Math.min(1, bounds.width / width, bounds.height / height)
      width *= f
      height *= f
    } else {
      width = Math.min(width, bounds.width)
      height = Math.min(height, bounds.height)
    }
  }
  const localCentre = { x: anchor.x + (sx * width) / 2, y: anchor.y + (sy * height) / 2 }
  const c = rotatePoint(localCentre, centre, b.rotation)
  if (bounds) return { ...b, x: clamp(c.x, 0, bounds.width), y: clamp(c.y, 0, bounds.height), width, height }
  return { ...b, x: c.x, y: c.y, width, height }
}

/** Contain-fits a content size into a box size: the drawn size, centred. */
export function containSize(content: Size, box: Size): Size {
  if (content.width <= 0 || content.height <= 0) return box
  const f = Math.min(box.width / content.width, box.height / content.height)
  return { width: content.width * f, height: content.height * f }
}

/** Distance between two points (pinch zoom). */
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
