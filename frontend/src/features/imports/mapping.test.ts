import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import { customAttribute, formFromMapping, fromColumn, fromConstant, mappingError, mappingFromForm, sameMapping } from './mapping'

const columns = [
  { letter: 'A', header: 'Model  number' },
  { letter: 'B', header: 'Name' },
  { letter: 'C', header: 'Name' },
  { letter: 'D', header: '' },
]

describe('mapping form', () => {
  it('puts each field at its column by header (ignoring case and spaces), else letter; the rest in lists', () => {
    const form = formFromMapping(
      {
        sourceKind: 'xlsx',
        headerRow: 3,
        dataStartRow: 4,
        createMissingCategories: true,
        fields: [
          { target: 'product.productType', value: 'zigbee' },
          { target: 'product.modelNumber', column: 'MODEL NUMBER', columnLetter: 'G' },
          { target: 'variant.sku', columnLetter: 'D' },
          { target: 'product.category', column: 'Category', columnLetter: 'Z' },
          { target: 'variant.image' },
          { target: 'attribute.series', value: 'S1' },
          { target: 'variant.name.en', column: 'Model number' },
        ],
      },
      columns,
    )
    expect(form).toMatchObject({
      headerRow: 3,
      dataStartRow: 4,
      productType: fromConstant,
      productTypeValue: 'zigbee',
      category: fromColumn,
      createMissingCategories: true,
      allOrNothing: true,
      imageAnyColumn: true,
      targets: { A: 'product.modelNumber', D: 'variant.sku' },
      constants: [{ target: 'attribute.series', value: 'S1' }],
      extras: [
        { target: 'product.category', column: 'Category', columnLetter: 'Z' },
        // Column A already feeds the model number.
        { target: 'variant.name.en', column: 'Model number', columnLetter: '' },
      ],
    })
  })

  it('builds the mapping with a location for each field, repeated headers by letter only', () => {
    const form = formFromMapping({ sourceKind: 'csv', headerRow: 1, dataStartRow: 2, productTypeId: 'pt', fields: [] }, columns)
    form.targets = { A: 'product.modelNumber', B: 'product.name.en', C: customAttribute, D: 'variant.sku' }
    form.customKeys = { C: ' series ' }
    form.category = fromConstant
    form.categoryValue = 'Gateways'
    form.constants = [{ target: 'variant.price', value: '10' }]
    const { mapping, fields } = mappingFromForm(form, columns, 'csv')
    expect(mapping).toEqual({
      sourceKind: 'csv',
      headerRow: 1,
      dataStartRow: 2,
      productTypeId: 'pt',
      createMissingCategories: false,
      allOrNothing: true,
      fields: [
        { target: 'product.category', value: 'Gateways' },
        { target: 'product.modelNumber', column: 'Model  number', columnLetter: 'A' },
        { target: 'product.name.en', columnLetter: 'B' },
        { target: 'attribute.series', columnLetter: 'C' },
        { target: 'variant.sku', columnLetter: 'D' },
        { target: 'variant.price', value: '10' },
      ],
    })
    expect(fields['mapping.fields[0].value']).toBe('categoryValue')
    expect(fields['mapping.fields[1].column']).toBe('targets.A')
    expect(fields['mapping.fields[5].value']).toBe('constants.0.value')
    expect(fields['mapping.productTypeId']).toBe('productType')
  })

  it('compares mappings ignoring field order, except between repeated targets', () => {
    const a = { sourceKind: 'xlsx' as const, headerRow: 1, dataStartRow: 2, fields: [{ target: 'b' }, { target: 'a' }, { target: 'addon.required', columnLetter: 'X' }, { target: 'addon.required', columnLetter: 'Y' }] }
    expect(sameMapping(a, { ...a, fields: [a.fields[1], a.fields[2], a.fields[0], a.fields[3]] })).toBe(true)
    expect(sameMapping(a, { ...a, fields: [a.fields[0], a.fields[1], a.fields[3], a.fields[2]] })).toBe(false)
  })

  it('moves the server errors where the form shows them', () => {
    const error = new ApiError({
      status: 422,
      code: 'validation.failed',
      fields: [
        { location: 'mapping.fields[1].column', code: 'import.column_missing', params: { column: 'X' } },
        { location: 'body.mapping.fields', code: 'import_profile.product_type_required' },
        { location: 'body.mapping.fields', code: 'import_profile.category_required' },
        { location: 'body.mapping.fields', code: 'import_profile.model_number_required' },
      ],
    })
    expect((mappingError(error) as ApiError).fields.map((f) => f.location)).toEqual([
      'body.mapping.fields[1].column',
      'body.mapping.productTypeId',
      'body.mapping.categoryId',
      'body.mapping.fields',
    ])
  })
})
