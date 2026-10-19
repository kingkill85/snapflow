import { describe, expect, it } from 'vitest'

import type { Category } from '@/api/generated/model'

import { toFormValues, toInput } from './form'

const category: Category = {
  id: 'c1',
  key: 'dimmers',
  mounting: 'floorplan',
  name: { en: 'Dimmers' },
  isActive: true,
  sortOrder: 1,
  can: { update: true, delete: true },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  attributes: [{ key: 'power', label: { en: 'Power' }, type: 'number', min: 0.5, max: 500, scope: 'product' }],
  instanceAttributes: [],
}

describe('category form', () => {
  it('shows decimal bounds with the decimal separator of the UI language and sends them back unchanged', () => {
    const values = toFormValues(category, ',')
    expect(values.attributes[0]).toMatchObject({ min: '0,5', max: '500' })
    expect(toInput(values).attributes[0]).toMatchObject({ min: 0.5, max: 500 })
    expect(toFormValues(category).attributes[0]).toMatchObject({ min: '0.5' })
  })
})
