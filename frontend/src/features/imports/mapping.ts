import { ApiError } from '@/api/client'
import type { ImportField, ImportMapping, ImportMappingSourceKind, ImportSourceColumn } from '@/api/generated/model'
import type { ApiFieldMap } from '@/components/ui'

// The mapping step's form and how it turns into an ImportMapping and back.
// The form is organised by the file's columns (one target per column), with
// the product type and category on their own, constant values and the
// mappings that fit no column of this file (e.g. a profile made for another
// file) as lists.

/** Product type / category choice: a fixed id, or one of these. */
export const fromColumn = '@column'
export const fromConstant = '@constant'
/** Target of a column mapped to an attribute key typed in (not in any category's schema yet). */
export const customAttribute = '@attribute'

export type ConstantRow = { target: string; value: string }
/** A mapping that is not one column's target: a column this file lacks, or a second target of a column. */
export type ExtraRow = { target: string; column: string; columnLetter: string; order?: number } & Link

/** An attribute column's link to a catalog field, or its answer "just information" (D188), kept as loaded. */
export type Link = { fieldKey?: string; information?: boolean }

/**
 * Targets that repeat (the add-ons): their order in the field list is the
 * order of the variant's add-on list, so the form keeps it (D120).
 */
export const isRepeatable = (target: string) => target.startsWith('addon.')

export type MappingForm = {
  sheet: string
  headerRow: number
  dataStartRow: number
  /** A product type id, fromColumn or fromConstant ('' while unset). */
  productType: string
  productTypeValue: string
  category: string
  categoryValue: string
  createMissingCategories: boolean
  allOrNothing: boolean
  /** Pictures floating over a row in any column (variant.image without a column). */
  imageAnyColumn: boolean
  /** Target per column letter ('' = not imported). */
  targets: Record<string, string>
  /** Attribute keys typed for columns whose target is customAttribute. */
  customKeys: Record<string, string>
  /**
   * The position a repeatable target (add-on) of a column had in the loaded
   * mapping, per column letter: such fields are sent in this order, ones
   * chosen since after them in column order.
   */
  order: Record<string, number>
  /**
   * The catalog field link (or "just information") of a column's attribute
   * target, per column letter, as loaded; sent while the column keeps that
   * target, so a profile keeps the answers.
   */
  links: Record<string, Link & { target: string }>
  constants: ConstantRow[]
  extras: ExtraRow[]
  /** Errors of the whole field list (e.g. "map the model number"). */
  fieldsRoot?: string
}

export const emptyForm = (): MappingForm => ({
  sheet: '',
  headerRow: 1,
  dataStartRow: 2,
  productType: '',
  productTypeValue: '',
  category: '',
  categoryValue: '',
  createMissingCategories: false,
  allOrNothing: true,
  imageAnyColumn: false,
  targets: {},
  customKeys: {},
  order: {},
  links: {},
  constants: [],
  extras: [],
})

/** Header texts compare like the server's: ignoring case and repeated white space. */
export const headerKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** The column a field reads in this file: by header text, else by letter (as the server matches). */
function findColumn(field: ImportField, columns: ImportSourceColumn[]): ImportSourceColumn | undefined {
  if (field.column) {
    const key = headerKey(field.column)
    const byHeader = columns.find((c) => c.header !== '' && headerKey(c.header) === key)
    if (byHeader) return byHeader
  }
  return field.columnLetter ? columns.find((c) => c.letter === field.columnLetter?.toUpperCase()) : undefined
}

/** The form for a mapping (a profile's or a run's) over the file's columns. */
export function formFromMapping(mapping: ImportMapping, columns: ImportSourceColumn[]): MappingForm {
  const form = emptyForm()
  form.sheet = mapping.sheet ?? ''
  form.headerRow = mapping.headerRow
  form.dataStartRow = mapping.dataStartRow
  form.createMissingCategories = mapping.createMissingCategories ?? false
  form.allOrNothing = mapping.allOrNothing ?? true
  if (mapping.productTypeId) form.productType = mapping.productTypeId
  if (mapping.categoryId) form.category = mapping.categoryId
  mapping.fields.forEach((field, index) => {
    const hasValue = field.value !== undefined && field.value !== null
    if (field.target === 'product.productType' && hasValue) {
      form.productType = fromConstant
      form.productTypeValue = field.value ?? ''
      return
    }
    if (field.target === 'product.category' && hasValue) {
      form.category = fromConstant
      form.categoryValue = field.value ?? ''
      return
    }
    if (hasValue) {
      form.constants.push({ target: field.target, value: field.value ?? '' })
      return
    }
    if (field.target === 'variant.image' && !field.column && !field.columnLetter) {
      form.imageAnyColumn = true
      return
    }
    if (field.target === 'product.productType') form.productType = fromColumn
    if (field.target === 'product.category') form.category = fromColumn
    const column = findColumn(field, columns)
    const repeatable = isRepeatable(field.target)
    if (column && !form.targets[column.letter]) {
      form.targets[column.letter] = field.target
      if (repeatable) form.order[column.letter] = index
      if (field.fieldKey || field.information) form.links[column.letter] = { target: field.target, ...linkOf(field) }
    } else {
      form.extras.push({
        target: field.target,
        column: field.column ?? '',
        columnLetter: field.columnLetter ?? '',
        ...(repeatable ? { order: index } : {}),
        ...linkOf(field),
      })
    }
  })
  return form
}

/** A field's catalog field link or "just information", without empty parts. */
export const linkOf = (f: Link): Link => ({ ...(f.fieldKey ? { fieldKey: f.fieldKey } : {}), ...(f.information ? { information: true } : {}) })

/** What the form sends, and where the server's errors about each part are shown. */
export type Built = { mapping: ImportMapping; fields: ApiFieldMap }

/** The mapping the form describes (the source's columns give header texts). */
export function mappingFromForm(form: MappingForm, columns: ImportSourceColumn[], sourceKind: ImportMappingSourceKind): Built {
  const fieldMap: Record<string, string> = {
    'mapping.sheet': 'sheet',
    'mapping.headerRow': 'headerRow',
    'mapping.dataStartRow': 'dataStartRow',
    'mapping.productTypeId': 'productType',
    'mapping.categoryId': 'category',
    'mapping.fields': 'fieldsRoot',
  }
  const fields: ImportField[] = []
  const add = (field: ImportField, at: string) => {
    const loc = `mapping.fields[${fields.length}]`
    for (const suffix of ['', '.target', '.column', '.columnLetter', '.value']) fieldMap[loc + suffix] = at
    fields.push(field)
  }
  if (form.productType === fromConstant) add({ target: 'product.productType', value: form.productTypeValue }, 'productTypeValue')
  if (form.category === fromConstant) add({ target: 'product.category', value: form.categoryValue }, 'categoryValue')

  // A header that appears twice would match its first column only: such columns go by letter.
  const counts = new Map<string, number>()
  for (const c of columns) if (c.header !== '') counts.set(headerKey(c.header), (counts.get(headerKey(c.header)) ?? 0) + 1)
  // Add-ons go after the other columns, in the order of the loaded mapping (D120).
  const repeated: { field: ImportField; at: string; order: number; position: number }[] = []
  const unordered = Number.MAX_SAFE_INTEGER
  columns.forEach((c, position) => {
    let target = form.targets[c.letter] ?? ''
    if (target === '') return
    if (target === customAttribute) target = `attribute.${(form.customKeys[c.letter] ?? '').trim()}`
    const unique = c.header !== '' && counts.get(headerKey(c.header)) === 1 && form.headerRow > 0
    const link = form.links[c.letter]
    const field = { target, ...(unique ? { column: c.header } : {}), columnLetter: c.letter, ...(link && link.target === target ? linkOf(link) : {}) }
    if (isRepeatable(target)) repeated.push({ field, at: `targets.${c.letter}`, order: form.order[c.letter] ?? unordered, position })
    else add(field, `targets.${c.letter}`)
  })
  const extra = (row: ExtraRow): ImportField => ({
    target: row.target,
    ...(row.column ? { column: row.column } : {}),
    ...(row.columnLetter ? { columnLetter: row.columnLetter } : {}),
    ...linkOf(row),
  })
  form.extras.forEach((row, i) => {
    if (isRepeatable(row.target)) repeated.push({ field: extra(row), at: `extras.${i}.target`, order: row.order ?? unordered, position: columns.length + i })
  })
  repeated.sort((a, b) => (a.order === b.order ? a.position - b.position : a.order < b.order ? -1 : 1))
  for (const r of repeated) add(r.field, r.at)
  if (form.imageAnyColumn && !Object.values(form.targets).includes('variant.image')) add({ target: 'variant.image' }, 'imageAnyColumn')
  form.constants.forEach((row, i) => add({ target: row.target, value: row.value }, `constants.${i}.value`))
  form.extras.forEach((row, i) => {
    if (!isRepeatable(row.target)) add(extra(row), `extras.${i}.target`)
  })

  const isId = (v: string) => v !== '' && v !== fromColumn && v !== fromConstant
  const mapping: ImportMapping = {
    sourceKind,
    ...(form.sheet ? { sheet: form.sheet } : {}),
    headerRow: form.headerRow,
    dataStartRow: form.dataStartRow,
    ...(isId(form.productType) ? { productTypeId: form.productType } : {}),
    ...(isId(form.category) ? { categoryId: form.category } : {}),
    createMissingCategories: form.createMissingCategories,
    allOrNothing: form.allOrNothing,
    fields,
  }
  return { mapping, fields: fieldMap }
}

/**
 * The server reports mapping problems at "mapping.*" (a profile) or
 * "body.mapping.*" (a mapping sent along); a missing product type or
 * category at the field list. This moves them where the form shows them:
 * all below "body.", the missing product type and category at their choice.
 */
export function mappingError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.fields.length === 0) return error
  const fields = error.fields.map((f) => {
    let location = f.location.startsWith('mapping.') || f.location === 'mapping' ? `body.${f.location}` : f.location
    if (location === 'body.mapping.fields' && f.code === 'import_profile.product_type_required') location = 'body.mapping.productTypeId'
    if (location === 'body.mapping.fields' && f.code === 'import_profile.category_required') location = 'body.mapping.categoryId'
    return { ...f, location }
  })
  return new ApiError({ status: error.status, code: error.code, params: error.params, fields })
}

/**
 * Where the form shows the server's errors about a profile's fields: the
 * server reports them by the profile's field index, which need not be the
 * form's (another order, a column the file lacks). Each profile field is
 * found among the form's by target and column header, letter or value.
 */
export function profileFieldMap(profile: ImportMapping, built: Built): ApiFieldMap {
  const map: Record<string, string> = {}
  for (const [location, at] of Object.entries(built.fields)) if (!location.startsWith('mapping.fields[')) map[location] = at
  const used = new Set<number>()
  const matches = (p: ImportField, f: ImportField) => {
    if (p.target !== f.target) return false
    if (p.value !== undefined && p.value !== null) return f.value === p.value
    if (f.value !== undefined && f.value !== null) return false
    if (p.column) return headerKey(f.column ?? '') === headerKey(p.column) || (!!p.columnLetter && f.columnLetter?.toUpperCase() === p.columnLetter.toUpperCase())
    if (p.columnLetter) return f.columnLetter?.toUpperCase() === p.columnLetter.toUpperCase()
    return !f.column && !f.columnLetter
  }
  profile.fields.forEach((p, i) => {
    const j = built.mapping.fields.findIndex((f, j) => !used.has(j) && matches(p, f))
    if (j < 0) return
    used.add(j)
    for (const suffix of ['', '.target', '.column', '.columnLetter', '.value']) {
      const at = built.fields[`mapping.fields[${j}]${suffix}`]
      if (at) map[`mapping.fields[${i}]${suffix}`] = at
    }
  })
  return map
}

/** Two mappings are the same (e.g. the form still shows the loaded profile). */
export const sameMapping = (a: ImportMapping, b: ImportMapping) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b))

function normalise(m: ImportMapping) {
  return {
    sheet: m.sheet ?? '',
    headerRow: m.headerRow,
    dataStartRow: m.dataStartRow,
    productTypeId: m.productTypeId ?? '',
    categoryId: m.categoryId ?? '',
    createMissingCategories: m.createMissingCategories ?? false,
    allOrNothing: m.allOrNothing ?? true,
    // By target, stable: repeated targets (add-ons) keep their order, which matters.
    fields: m.fields
      .map((f) => [f.target, headerKey(f.column ?? ''), (f.columnLetter ?? '').toUpperCase(), f.value ?? null, f.fieldKey ?? '', f.information ?? false] as const)
      .sort((x, y) => x[0].localeCompare(y[0])),
  }
}
