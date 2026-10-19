import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import { catalog, placement, variant, zigbeeId } from '../test-fixtures'
import { defaultPlacementSize, groupPalette, paletteProducts } from './catalog'
import { duplicatePlacements } from './placements'
import { saveErrorsByItem } from './save-errors'
import { shortcutOf } from './use-shortcuts'

const localize = (t?: Record<string, string | undefined>) => t?.en ?? ''
const byId = new Map(catalog.map((v) => [v.id, v]))

describe('palette products', () => {
  it('offers available variants of the project types by product, the first one as default', () => {
    const products = paletteProducts([...catalog, variant(5, { available: false })], [zigbeeId])
    expect(products.map((p) => localize(p.name))).toEqual(['Wall switch', 'Motion sensor'])
    expect(products[0].variants).toHaveLength(2)
    expect(products[0].defaultVariant.id).toBe(catalog[0].id)
  })

  it('groups by category and searches names, model numbers and variants', () => {
    const products = paletteProducts(catalog, [zigbeeId])
    expect(groupPalette(products, '', localize).map((g) => localize(g.category.name))).toEqual(['Switches', 'Sensors'])
    expect(groupPalette(products, 'motion', localize).flatMap((g) => g.products.map((p) => localize(p.name)))).toEqual(['Motion sensor'])
    expect(groupPalette(products, 'black', localize).flatMap((g) => g.products.map((p) => localize(p.name)))).toEqual(['Wall switch'])
    expect(groupPalette(products, 'M-3', localize)).toHaveLength(1)
    expect(groupPalette(products, 'nothing', localize)).toEqual([])
  })
})

describe('default placement size', () => {
  it('takes the last placed size of the product (any variant), else 60 px high at the image aspect', () => {
    const productId = catalog[0].productId
    const placements = [
      placement(1, { variantId: catalog[0].id, width: 40, height: 40 }),
      placement(2, { variantId: catalog[2].id, width: 99, height: 99 }),
      placement(3, { variantId: catalog[1].id, width: 50, height: 30 }),
    ]
    expect(defaultPlacementSize(productId, placements, byId, 2)).toEqual({ width: 50, height: 30 })
    expect(defaultPlacementSize(productId, [], byId, 2)).toEqual({ width: 120, height: 60 })
    expect(defaultPlacementSize(productId, [], byId, undefined)).toEqual({ width: 60, height: 60 })
  })
})

describe('save errors', () => {
  it('maps body.placements[i] to the id of the i-th placement that was sent', () => {
    const snapshot = { scale: null, zones: [], placements: [placement(1), placement(2)] }
    const error = new ApiError({
      status: 422,
      code: 'validation.failed',
      fields: [
        { location: 'body.placements[1].variantId', code: 'plan.variant_not_found' },
        { location: 'body.placements[1].x', code: 'plan.variant_not_found' },
        { location: 'body.scale', code: 'validation.min' },
      ],
    })
    const byItem = saveErrorsByItem(error, snapshot, (f) => f.code)
    expect([...byItem.entries()]).toEqual([[placement(2).id, ['plan.variant_not_found']]])
    expect(saveErrorsByItem(new Error('x'), snapshot, (f) => f.code).size).toBe(0)
  })
})

describe('shortcuts', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })
  it('maps keys to commands, with Ctrl or Cmd', () => {
    expect(shortcutOf(key('z', { ctrlKey: true }))).toBe('undo')
    expect(shortcutOf(key('Z', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(shortcutOf(key('y', { ctrlKey: true }))).toBe('redo')
    expect(shortcutOf(key('d', { metaKey: true }))).toBe('duplicate')
    expect(shortcutOf(key('Delete'))).toBe('delete')
    expect(shortcutOf(key('ArrowLeft', { shiftKey: true }))).toBe('nudge')
    expect(shortcutOf(key('Escape'))).toBe('escape')
    expect(shortcutOf(key('z'))).toBeUndefined()
  })

  it('duplicates with new ids and an offset', () => {
    const [copy] = duplicatePlacements([placement(1, { zoneId: 'z' })], 20, 20)
    expect(copy.id).not.toBe(placement(1).id)
    expect(copy).toMatchObject({ x: 120, y: 120, zoneId: null, variantId: placement(1).variantId })
  })
})
