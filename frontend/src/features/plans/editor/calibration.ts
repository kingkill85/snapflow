import { distance, type Point } from '@/canvas'
import { parseDecimal } from '@/catalog/decimal'

/** Metres per image pixel from two points and the real distance between them; undefined when not computable. */
export function scaleFrom(a: Point, b: Point, metres: number): number | undefined {
  const px = distance(a, b)
  if (!(px > 0) || !(metres > 0) || !Number.isFinite(metres)) return undefined
  return metres / px
}

/** A distance in metres as typed ("3,5" or "3.5", D144); undefined unless a positive number. */
export function parseMetres(text: string): number | undefined {
  const point = parseDecimal(text)
  const n = point === undefined ? Number.NaN : Number(point)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The scale bar for a scale (metres per image pixel) at a zoom: a round
 * length (1, 2 or 5 × 10^n metres) whose bar is at most `maxPx` screen pixels
 * long, and that bar's length in screen pixels.
 */
export function scaleBar(scale: number, zoom: number, maxPx = 120): { metres: number; px: number } | undefined {
  const metresPerScreenPx = scale / zoom
  if (!(metresPerScreenPx > 0) || !Number.isFinite(metresPerScreenPx)) return undefined
  const max = metresPerScreenPx * maxPx
  const magnitude = 10 ** Math.floor(Math.log10(max))
  const metres = [5, 2, 1].map((f) => f * magnitude).find((m) => m <= max) ?? magnitude
  return { metres, px: metres / metresPerScreenPx }
}
