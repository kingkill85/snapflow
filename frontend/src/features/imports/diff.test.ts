import { describe, expect, it } from 'vitest'

import { changedFields, compactRows } from './diff'
import { attributeLabels } from './labels'
import { targets } from './test-fixtures'

describe('change log fields', () => {
  it('shows a created variant without its bookkeeping (ids, versions, order)', () => {
    const fields = changedFields({
      seq: 1,
      entity: 'variant',
      action: 'create',
      entityId: 'v1',
      label: 'GW-1 Black',
      after: {
        id: 'v1',
        productId: 'p1',
        name: { en: 'Black' },
        sku: 'GW-1 Black',
        price: '27.50',
        attributes: {},
        sortOrder: 0,
        isActive: true,
        updatedAt: '2026-10-18T22:16:21.950305+02:00',
        addonsUpdatedAt: '2026-10-18T22:16:21.950305+02:00',
      },
    })
    expect(fields.map((f) => f.field)).toEqual(['name.en', 'sku', 'price', 'isActive'])
  })

  it('compacts row numbers to ranges', () => {
    expect(compactRows([9, 4, 5, 6, 5])).toBe('4–6, 9')
  })
})

describe('attribute labels', () => {
  it('takes the catalog label, else the header of the column the mapping imports the key from', () => {
    const labels = attributeLabels(targets, {
      sourceKind: 'xlsx',
      headerRow: 3,
      dataStartRow: 4,
      allOrNothing: true,
      createMissingCategories: true,
      fields: [
        { target: 'attribute.width_te', column: 'TE' },
        { target: 'attribute.dimensions', column: ' Dimensions  (mm) ', columnLetter: 'H' },
        { target: 'attribute.series', value: 'S1' },
      ],
    })
    expect(Object.fromEntries(labels)).toEqual({ width_te: { en: 'Width', de: 'Breite' }, dimensions: { en: 'Dimensions (mm)' } })
  })
})
