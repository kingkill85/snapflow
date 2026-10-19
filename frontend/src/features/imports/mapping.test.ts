import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import { customAttribute, formFromMapping, fromColumn, fromConstant, mappingError, mappingFromForm, profileFieldMap, sameMapping } from './mapping'

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

describe('add-on order and profile errors', () => {
  const file = [
    { letter: 'A', header: 'Model' },
    { letter: 'B', header: 'Addon 1' },
    { letter: 'C', header: 'Addon 2' },
    { letter: 'D', header: 'Optional' },
  ]
  // Add-ons out of the file's column order, a column the file lacks between them.
  const profile = {
    sourceKind: 'xlsx' as const,
    headerRow: 1,
    dataStartRow: 2,
    productTypeId: 'pt',
    categoryId: 'cat',
    fields: [
      { target: 'addon.optional', column: 'Optional', columnLetter: 'D' },
      { target: 'addon.required', column: 'Addon 2', columnLetter: 'C' },
      { target: 'addon.required', column: 'Gone', columnLetter: 'X' },
      { target: 'addon.required', column: 'Addon 1', columnLetter: 'B' },
      { target: 'product.modelNumber', column: 'Model', columnLetter: 'A' },
    ],
  }

  it("keeps a loaded mapping's add-on order, so the form still equals it; new add-ons go last", () => {
    const form = formFromMapping(profile, file)
    expect(form.order).toEqual({ D: 0, C: 1, B: 3 })
    expect(form.extras).toEqual([{ target: 'addon.required', column: 'Gone', columnLetter: 'X', order: 2 }])
    const built = mappingFromForm(form, file, 'xlsx')
    expect(built.mapping.fields.filter((f) => f.target.startsWith('addon.')).map((f) => f.column)).toEqual(['Optional', 'Addon 2', 'Gone', 'Addon 1'])
    expect(sameMapping(profile, built.mapping)).toBe(true)

    // The model number's column becomes an add-on too: after the loaded ones.
    const more = mappingFromForm({ ...form, targets: { ...form.targets, A: 'addon.optional' } }, file, 'xlsx')
    expect(more.mapping.fields.map((f) => f.column)).toEqual(['Optional', 'Addon 2', 'Gone', 'Addon 1', 'Model'])
  })

  it("maps a profile's errors by its own field index to where the form shows that field", () => {
    const form = formFromMapping(profile, file)
    const fields = profileFieldMap(profile, mappingFromForm(form, file, 'xlsx'))
    expect(fields['mapping.fields[0].column']).toBe('targets.D')
    expect(fields['mapping.fields[1].column']).toBe('targets.C')
    expect(fields['mapping.fields[2].column']).toBe('extras.0.target')
    expect(fields['mapping.fields[3]']).toBe('targets.B')
    expect(fields['mapping.fields[4].target']).toBe('targets.A')
    expect(fields['mapping.headerRow']).toBe('headerRow')
    expect(fields['mapping.fields[5]']).toBeUndefined()
  })
})

describe('catalog field links (D188)', () => {
  const linked = {
    sourceKind: 'xlsx' as const,
    headerRow: 1,
    dataStartRow: 2,
    fields: [
      { target: 'product.modelNumber', column: 'Model number', columnLetter: 'A' },
      { target: 'attribute.width', columnLetter: 'B', fieldKey: 'width_te' },
      { target: 'attribute.notes', columnLetter: 'D', information: true },
      { target: 'attribute.gone', column: 'Gone', columnLetter: 'X', fieldKey: 'gone_field' },
    ],
  }

  it('keeps a column’s link while it keeps its target, also in further mappings', () => {
    const form = formFromMapping(linked, columns)
    const built = mappingFromForm(form, columns, 'xlsx').mapping
    expect(built.fields).toContainEqual({ target: 'attribute.width', columnLetter: 'B', fieldKey: 'width_te' })
    expect(built.fields).toContainEqual({ target: 'attribute.notes', columnLetter: 'D', information: true })
    expect(built.fields).toContainEqual({ target: 'attribute.gone', column: 'Gone', columnLetter: 'X', fieldKey: 'gone_field' })
    expect(sameMapping(built, linked)).toBe(true)
    // Another target drops the link; a mapping without the links differs.
    const changed = mappingFromForm({ ...form, targets: { ...form.targets, B: 'attribute.other' } }, columns, 'xlsx').mapping
    expect(changed.fields).toContainEqual({ target: 'attribute.other', columnLetter: 'B' })
    expect(sameMapping(built, { ...linked, fields: linked.fields.map(({ target, column, columnLetter }) => ({ target, column, columnLetter })) })).toBe(false)
  })
})
