import { describe, expect, it } from 'vitest'

import type { AttributeDefinition } from '@/api/generated/model'

import { apiPrice, type ProductFormValues, toAttributes, toProductInput, toVariantInput, type VariantFormValues, variantSchema } from './form'

const variant = (overrides: Partial<VariantFormValues> = {}): VariantFormValues => ({
  name: { en: 'Standard', de: '' },
  sku: '',
  price: '27,5',
  imageFileId: '',
  isActive: true,
  values: {},
  keep: {},
  ...overrides,
})

const product = (overrides: Partial<ProductFormValues> = {}): ProductFormValues => ({
  productTypeId: 'type',
  categoryId: 'category',
  modelNumber: ' M1 ',
  name: { en: 'Dimmer', de: '  ' },
  description: { en: ' ', de: '' },
  isActive: true,
  mounting: '',
  values: {},
  keep: {},
  ...overrides,
})

describe('product and variant forms', () => {
  it('leaves out a blank SKU, no image and a blank German name, and sends the price in point form', () => {
    expect(toVariantInput(variant({ sku: '  ' }), {})).toEqual({ name: { en: 'Standard' }, price: '27.5', attributes: {}, isActive: true })
    expect(toVariantInput(variant({ sku: ' SK-1 ', imageFileId: 'f1', name: { en: 'White', de: 'Weiß' } }), { gloss: true })).toEqual({
      name: { en: 'White', de: 'Weiß' },
      sku: 'SK-1',
      price: '27.5',
      imageFileId: 'f1',
      attributes: { gloss: true },
      isActive: true,
    })
  })

  it('leaves out a blank description and blank German texts', () => {
    expect(toProductInput(product(), {})).toEqual({ productTypeId: 'type', categoryId: 'category', modelNumber: 'M1', name: { en: 'Dimmer' }, attributes: {}, isActive: true, mounting: '' })
    expect(toProductInput(product({ description: { en: 'Four channels', de: ' ' } }), {}).description).toEqual({ en: 'Four channels' })
    expect(toProductInput(product({ description: { en: 'Four', de: 'Vier' } }), {}).description).toEqual({ en: 'Four', de: 'Vier' })
  })

  it('takes prices with a point or a comma in the API format only', () => {
    expect(apiPrice('27,5')).toBe('27.5')
    expect(apiPrice(' 27.50 ')).toBe('27.50')
    expect(apiPrice('27')).toBe('27')
    for (const text of ['1.234', '0x1', '1e3', '-1', '27.505', '27.5.0', '', '12345678901']) expect(apiPrice(text)).toBeUndefined()
  })

  it('reports a price that is not one with the server code', () => {
    const result = variantSchema.safeParse(variant({ price: '27.5.0' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['price', 'variant.price_format']])
    expect(variantSchema.safeParse(variant({ price: '27,50' })).success).toBe(true)
  })

  it('sends kept values outside the schema unchanged and leaves out removed ones', () => {
    const defs: AttributeDefinition[] = [{ key: 'power', label: { en: 'Power' }, type: 'number' }]
    const stored = { power: 5, old: { nested: [1] }, gone: 'x' }
    expect(toAttributes(defs, { power: '7,5' }, { old: true, gone: false }, stored)).toEqual({
      attributes: { power: 7.5, old: { nested: [1] } },
      errors: [],
    })
    expect(toAttributes(defs, { power: 'x' }, {}, stored).errors).toEqual([{ name: 'values.power', message: 'validation.number' }])
  })
})
