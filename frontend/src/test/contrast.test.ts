import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Contrast of the design tokens in index.css, light and dark, for the pairs
// the components draw (WCAG 2.2: 4.5:1 for text, 3:1 for the parts of a
// control, 1.4.11): the switch's track and knob, the TranslatableField's
// tab marks and fallback placeholder.

const css = readFileSync(join(import.meta.dirname, '..', 'index.css'), 'utf8')

/** The --color-* tokens declared in a block of index.css. */
function tokens(block: string): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {}
  for (const m of block.matchAll(/--color-([\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])]
  return out
}
const light = tokens(css.slice(css.indexOf('@theme'), css.indexOf('@layer base')))
const dark = { ...light, ...tokens(css.slice(css.indexOf(":root[data-theme='dark'] {"))) }

/** OKLCH to linear sRGB, clipped to the gamut. */
function linear([l, c, h]: [number, number, number]): number[] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map((v) => Math.min(1, Math.max(0, v)))
}
const luminance = (c: [number, number, number]) => {
  const [r, g, b] = linear(c)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe.each([
  ['light', light],
  ['dark', dark],
])('contrast in the %s theme', (_, t) => {
  it('switch: the off track against the surfaces, the knob against the track (3:1)', () => {
    for (const bg of ['surface', 'raised']) {
      expect(ratio(t.muted, t[bg]), `muted track on ${bg}`).toBeGreaterThanOrEqual(3)
      expect(ratio(t.primary, t[bg]), `primary track on ${bg}`).toBeGreaterThanOrEqual(3)
    }
    expect(ratio(t.raised, t.muted), 'knob on the off track').toBeGreaterThanOrEqual(3)
    expect(ratio(t.raised, t.primary), 'knob on the on track').toBeGreaterThanOrEqual(3)
  })

  it('translatable field: tab marks (3:1) and the fallback placeholder (4.5:1)', () => {
    expect(ratio(t.muted, t.canvas), 'missing mark on the tab list').toBeGreaterThanOrEqual(3)
    for (const bg of ['surface', 'raised']) expect(ratio(t.muted, t[bg]), `placeholder on ${bg}`).toBeGreaterThanOrEqual(4.5)
  })
})
