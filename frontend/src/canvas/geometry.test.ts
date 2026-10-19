import { describe, expect, it } from 'vitest'

import {
  angleTo,
  boundsOf,
  boxCorners,
  clampZoom,
  containSize,
  fitViewport,
  imageToScreen,
  normalizeAngle,
  pointInBox,
  rectFromPoints,
  rectsIntersect,
  resizeBox,
  rotatePoint,
  screenToImage,
  snapAngle,
  wheelFactor,
  zoomAt,
} from './geometry'

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('canvas geometry', () => {
  it('maps image and screen pixels both ways', () => {
    const v = { x: 10, y: 20, scale: 2 }
    expect(imageToScreen(v, { x: 5, y: 5 })).toEqual({ x: 20, y: 30 })
    expect(screenToImage(v, { x: 20, y: 30 })).toEqual({ x: 5, y: 5 })
  })

  it('zooms around the pointer and clamps to 10–800 %', () => {
    const v = { x: 0, y: 0, scale: 1 }
    const pointer = { x: 100, y: 50 }
    const zoomed = zoomAt(v, pointer, 2)
    expect(zoomed.scale).toBe(2)
    // The image point under the pointer stays under it.
    expect(screenToImage(zoomed, pointer)).toEqual(screenToImage(v, pointer))
    expect(zoomAt(v, pointer, 100).scale).toBe(8)
    expect(clampZoom(0.01)).toBe(0.1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(-100)).toBeGreaterThan(1)
  })

  it('fits the image centred with padding', () => {
    const v = fitViewport({ width: 1000, height: 500 }, { width: 532, height: 532 })
    close(v.scale, 0.5)
    close(v.x, 16)
    close(v.y, (532 - 250) / 2)
    expect(fitViewport({ width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({ x: 0, y: 0, scale: 1 })
  })

  it('normalises and snaps angles to [0, 360)', () => {
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(-90)).toBe(270)
    expect(normalizeAngle(725)).toBe(5)
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true)
    expect(snapAngle(7)).toBe(0)
    expect(snapAngle(8)).toBe(15)
    expect(snapAngle(353)).toBe(0)
  })

  it('rotates points clockwise on screen', () => {
    const p = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90)
    close(p.x, 0)
    close(p.y, 1)
    expect(angleTo({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(0)
    close(angleTo({ x: 0, y: 0 }, { x: 10, y: 0 }), 90)
  })

  it('finds corners, bounds and hits of rotated boxes', () => {
    const box = { x: 0, y: 0, width: 4, height: 2, rotation: 90 }
    const bounds = boundsOf(boxCorners(box))
    close(bounds.width, 2)
    close(bounds.height, 4)
    expect(pointInBox({ x: 0, y: 1.9 }, box)).toBe(true)
    expect(pointInBox({ x: 1.9, y: 0 }, box)).toBe(false)
  })

  it('spans and intersects rectangles', () => {
    const r = rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 5 })
    expect(r).toEqual({ x: 0, y: 5, width: 10, height: 5 })
    expect(rectsIntersect(r, { x: 9, y: 9, width: 5, height: 5 })).toBe(true)
    expect(rectsIntersect(r, { x: 11, y: 0, width: 5, height: 5 })).toBe(false)
  })

  it('resizes from a corner, keeping the opposite corner and optionally the aspect', () => {
    const box = { x: 50, y: 50, width: 20, height: 10, rotation: 0 }
    const free = resizeBox(box, 'se', { x: 80, y: 70 }, false)
    expect(free).toMatchObject({ x: 60, y: 57.5, width: 40, height: 25 })
    const kept = resizeBox(box, 'se', { x: 80, y: 70 }, true)
    expect(kept.width / kept.height).toBeCloseTo(2)
    expect(kept.width).toBeCloseTo(50)
    // The opposite (nw) corner stays at (40, 45).
    expect(kept.x - kept.width / 2).toBeCloseTo(40)
    expect(kept.y - kept.height / 2).toBeCloseTo(45)
    expect(resizeBox(box, 'nw', { x: 100, y: 100 }, false, 1)).toMatchObject({ width: 1, height: 1 })
  })

  it('keeps a resized box within the image: size at most the image, centre inside', () => {
    const image = { width: 100, height: 80 }
    const box = { x: 90, y: 40, width: 20, height: 10, rotation: 0 }
    const free = resizeBox(box, 'se', { x: 500, y: 500 }, false, 1, image)
    expect(free.width).toBeLessThanOrEqual(100)
    expect(free.height).toBeLessThanOrEqual(80)
    expect(free.x).toBeLessThanOrEqual(100)
    expect(free.y).toBeLessThanOrEqual(80)
    const kept = resizeBox(box, 'se', { x: 900, y: 500 }, true, 1, image)
    expect(kept.width).toBeLessThanOrEqual(100)
    expect(kept.height).toBeLessThanOrEqual(80)
    expect(kept.width / kept.height).toBeCloseTo(2)
    expect(resizeBox(box, 'nw', { x: -500, y: -500 }, false, 1, image)).toMatchObject({ width: 100, height: 80 })
  })

  it('resizes a rotated box in its own frame', () => {
    const box = { x: 0, y: 0, width: 10, height: 10, rotation: 90 }
    // The se corner of a box turned by 90° sits at the screen's bottom left.
    const r = resizeBox(box, 'se', { x: -10, y: 10 }, false)
    close(r.width, 15)
    close(r.height, 15)
  })

  it('contain-fits content into a box', () => {
    expect(containSize({ width: 200, height: 100 }, { width: 50, height: 50 })).toEqual({ width: 50, height: 25 })
  })
})
