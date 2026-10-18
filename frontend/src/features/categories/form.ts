import { z } from 'zod'

import {
  type AttributeDefinition,
  AttributeDefinitionItemType,
  AttributeDefinitionScope,
  AttributeDefinitionType,
  type Category,
  type CategoryInput,
  type InstanceAttributeDefinition,
} from '@/api/generated/model'
import { parseDecimal } from '@/catalog/decimal'
import { type ApiFieldMap, errorKey } from '@/components/ui'

// The editor's form mirrors the API body (name.en, attributes.2.options.0.key, ...),
// so the API's field error locations map 1:1 to form fields. Numbers are edited
// as text and converted on save. The server is the authority on every rule; the
// checks here only catch the obvious mistakes before a round trip, with the
// server's codes and limits (D36, D39, D40).

/** Limits of the API (D36, D40). */
export const limits = { key: 64, unit: 16, name: 100, description: 2000, label: 100, attributeDescription: 500, attributes: 200, options: 500 }
const maxSafeInteger = Number.MAX_SAFE_INTEGER

const keyPattern = /^[a-z][a-z0-9_]*$/

const tooLong = (max: number) => errorKey('validation.too_long', { max })
const key = (format: 'category.key_format' | 'attribute.key_format') =>
  z.string().max(limits.key, tooLong(limits.key)).regex(keyPattern, errorKey(format))

const text = (max: number) => z.object({ en: z.string().max(max, tooLong(max)), de: z.string().max(max, tooLong(max)) })
const requiredText = (max: number, message: 'validation.required' | 'attribute.label_required') =>
  z.object({ en: z.string().max(max, tooLong(max)).refine((v) => v.trim() !== '', errorKey(message)), de: z.string().max(max, tooLong(max)) })

/** Whether min/max apply to a type (value range, text length or item count). */
export const hasBounds = (type: AttributeDefinitionType) => type === 'text' || type === 'number' || type === 'integer' || type === 'list'

/** Whether an attribute row edits options (an enum, or a list of enums). */
export const hasOptions = (type: AttributeDefinitionType, itemType: AttributeDefinitionItemType) =>
  type === 'enum' || (type === 'list' && itemType === 'enum')

/** Whether min/max are whole numbers (all but number); lengths and item counts are also not negative. */
export const wholeBounds = (type: AttributeDefinitionType) => type !== 'number'
const nonNegativeBounds = (type: AttributeDefinitionType) => type === 'text' || type === 'list'

/** A bound as typed ("2,5" or "2.5", D71) as a number; NaN if it is not one. */
const boundNumber = (v: string) => {
  const decimal = parseDecimal(v)
  return decimal === undefined ? Number.NaN : Number(decimal)
}
const isNumber = (v: string) => Number.isFinite(boundNumber(v))

type Ctx = z.RefinementCtx
const requireEnglish = (t: { en: string; de: string }, path: (string | number)[], ctx: Ctx) => {
  if (t.de.trim() !== '' && t.en.trim() === '') ctx.addIssue({ code: 'custom', path: [...path, 'en'], message: errorKey('validation.required') })
}

const option = z.object({ key: z.string(), label: text(limits.label) })

const attribute = z
  .object({
    key: key('attribute.key_format'),
    /** The key a duplicated row got; it must be changed before saving. Not sent. */
    copiedKey: z.string(),
    label: requiredText(limits.label, 'attribute.label_required'),
    description: text(limits.attributeDescription),
    type: z.enum(AttributeDefinitionType),
    required: z.boolean(),
    unit: z.string().max(limits.unit, tooLong(limits.unit)),
    scope: z.enum(AttributeDefinitionScope),
    min: z.string(),
    max: z.string(),
    itemType: z.enum(AttributeDefinitionItemType),
    options: z.array(option),
  })
  .superRefine((a, ctx) => {
    if (a.copiedKey !== '' && a.key === a.copiedKey) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: errorKey('attribute.key_copy') })
    }
    requireEnglish(a.description, ['description'], ctx)
    if (hasBounds(a.type)) checkBounds(a, ctx)
    if (hasOptions(a.type, a.itemType)) checkOptions(a.options, ctx)
  })

type AttributeShape = z.infer<typeof attribute>

/** The checks of attrschema's checkBounds, with the same codes. */
function checkBounds(a: AttributeShape, ctx: Ctx) {
  const whole = wholeBounds(a.type)
  const nonNegative = nonNegativeBounds(a.type)
  const bound = (name: 'min' | 'max'): number | null | undefined => {
    const v = a[name].trim()
    if (v === '') return undefined
    const issue = (message: string) => {
      ctx.addIssue({ code: 'custom', path: [name], message })
      return null
    }
    if (!isNumber(v)) return issue(errorKey('validation.number'))
    const n = boundNumber(v)
    if (whole && !Number.isInteger(n)) return issue(errorKey('attribute.bound_whole'))
    if (nonNegative && n < 0) return issue(errorKey('attribute.bound_negative'))
    if (whole && Math.abs(n) > maxSafeInteger) {
      return issue(errorKey('attribute.bound_range', { min: nonNegative ? 0 : -maxSafeInteger, max: maxSafeInteger }))
    }
    return n
  }
  const min = bound('min')
  const max = bound('max')
  if (min === null || max === null) return
  if (min !== undefined && max !== undefined && min > max) {
    ctx.addIssue({ code: 'custom', path: ['max'], message: errorKey('attribute.range_invalid', { min }) })
  } else if (a.required && nonNegative && max !== undefined && max < 1) {
    ctx.addIssue({ code: 'custom', path: ['max'], message: errorKey('attribute.required_max', { min: 1 }) })
  }
}

function checkOptions(options: AttributeShape['options'], ctx: Ctx) {
  if (options.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: errorKey('attribute.options_required') })
  }
  if (options.length > limits.options) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: errorKey('validation.too_many', { max: limits.options }) })
  }
  const seen = new Set<string>()
  options.forEach((o, j) => {
    if (o.key.length > limits.key) {
      ctx.addIssue({ code: 'custom', path: ['options', j, 'key'], message: tooLong(limits.key) })
    } else if (!keyPattern.test(o.key)) {
      ctx.addIssue({ code: 'custom', path: ['options', j, 'key'], message: errorKey('attribute.key_format') })
    } else if (seen.has(o.key)) {
      ctx.addIssue({ code: 'custom', path: ['options', j, 'key'], message: errorKey('attribute.option_key_duplicate') })
    }
    seen.add(o.key)
    if (o.label.en.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['options', j, 'label', 'en'], message: errorKey('attribute.label_required') })
    }
    requireEnglish(o.label, ['options', j, 'label'], ctx)
  })
}

const schemaList = z
  .array(attribute)
  .max(limits.attributes, errorKey('validation.too_many', { max: limits.attributes }))
  .superRefine((list, ctx) => {
    const seen = new Set<string>()
    list.forEach((a, i) => {
      if (a.key !== '' && seen.has(a.key)) {
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: errorKey('attribute.key_duplicate') })
      }
      seen.add(a.key)
    })
  })

export const formSchema = z
  .object({
    key: key('category.key_format'),
    name: requiredText(limits.name, 'validation.required'),
    description: text(limits.description),
    isActive: z.boolean(),
    attributes: schemaList,
    instanceAttributes: schemaList,
  })
  .superRefine((v, ctx) => requireEnglish(v.description, ['description'], ctx))

export type FormValues = z.infer<typeof formSchema>
export type AttributeValues = FormValues['attributes'][number]
/** The two attribute schemas of a category. */
export type SchemaName = 'attributes' | 'instanceAttributes'

/**
 * API error locations shown at the editor's fields, for the given values:
 * only fields the editor renders for each row's type (D24), so every other
 * error is spelled out above the buttons instead.
 */
export function editorFields(v: FormValues): ApiFieldMap {
  const map: Record<string, string> = {}
  for (const name of ['key', 'name.en', 'name.de', 'description.en', 'description.de']) map[name] = name
  for (const schema of ['attributes', 'instanceAttributes'] as const) {
    map[schema] = `${schema}.root`
    v[schema].forEach((a, i) => {
      const leaves = ['key', 'label.en', 'label.de', 'description.en', 'description.de', 'type', 'unit']
      if (schema === 'attributes') leaves.push('scope')
      if (a.type === 'list') leaves.push('itemType')
      if (hasBounds(a.type)) leaves.push('min', 'max')
      for (const leaf of leaves) map[`${schema}[${i}].${leaf}`] = `${schema}.${i}.${leaf}`
      if (!hasOptions(a.type, a.itemType)) return
      map[`${schema}[${i}].options`] = `${schema}.${i}.options.root`
      a.options.forEach((_, j) => {
        for (const leaf of ['key', 'label.en', 'label.de']) map[`${schema}[${i}].options[${j}].${leaf}`] = `${schema}.${i}.options.${j}.${leaf}`
      })
    })
  }
  return map
}

export const emptyOption = (): AttributeValues['options'][number] => ({ key: '', label: { en: '', de: '' } })

export const emptyAttribute = (): AttributeValues => ({
  key: '',
  copiedKey: '',
  label: { en: '', de: '' },
  description: { en: '', de: '' },
  type: 'text',
  required: false,
  unit: '',
  scope: 'product',
  min: '',
  max: '',
  itemType: 'text',
  options: [],
})

/** A copy of an attribute row; its key gets "_copy" and must be changed before saving. */
export const copyAttribute = (a: AttributeValues): AttributeValues => {
  const copied = `${a.key}_copy`
  return { ...structuredClone(a), key: copied, copiedKey: copied }
}

const textValues = (t?: { [locale: string]: string }) => ({ en: t?.en ?? '', de: t?.de ?? '' })
const bound = (n?: number) => (n === undefined ? '' : String(n))

const toAttributeValues = (a: AttributeDefinition | InstanceAttributeDefinition): AttributeValues => ({
  key: a.key,
  copiedKey: '',
  label: textValues(a.label),
  description: textValues(a.description),
  type: a.type,
  required: a.required ?? false,
  unit: a.unit ?? '',
  scope: ('scope' in a ? a.scope : undefined) ?? 'product',
  min: bound(a.min),
  max: bound(a.max),
  itemType: a.itemType ?? 'text',
  options: (a.options ?? []).map((o) => ({ key: o.key, label: textValues(o.label) })),
})

/** The form's values for a category, or for a new one. */
export function toFormValues(item: Category | null): FormValues {
  return {
    key: item?.key ?? '',
    name: textValues(item?.name),
    description: textValues(item?.description),
    isActive: item?.isActive ?? true,
    attributes: (item?.attributes ?? []).map(toAttributeValues),
    instanceAttributes: (item?.instanceAttributes ?? []).map(toAttributeValues),
  }
}

/** {en, de} without a blank German text. */
const localized = (t: { en: string; de: string }) => ({ en: t.en, ...(t.de.trim() ? { de: t.de } : {}) })
/** Like localized, but nothing when both are blank. */
const optionalLocalized = (t: { en: string; de: string }) => (t.en.trim() || t.de.trim() ? localized(t) : undefined)

const toInstanceDefinition = (a: AttributeValues): InstanceAttributeDefinition => {
  const description = optionalLocalized(a.description)
  return {
    key: a.key,
    label: localized(a.label),
    ...(description ? { description } : {}),
    type: a.type,
    required: a.required,
    ...(a.unit.trim() ? { unit: a.unit } : {}),
    ...(hasBounds(a.type) && a.min.trim() ? { min: boundNumber(a.min) } : {}),
    ...(hasBounds(a.type) && a.max.trim() ? { max: boundNumber(a.max) } : {}),
    ...(a.type === 'list' ? { itemType: a.itemType } : {}),
    ...(hasOptions(a.type, a.itemType) ? { options: a.options.map((o) => ({ key: o.key, label: localized(o.label) })) } : {}),
  }
}

const toDefinition = (a: AttributeValues): AttributeDefinition => ({ ...toInstanceDefinition(a), scope: a.scope })

/** The API body for the form's values: only what applies to each attribute's type. */
export function toInput(v: FormValues): CategoryInput {
  const description = optionalLocalized(v.description)
  return {
    key: v.key,
    name: localized(v.name),
    ...(description ? { description } : {}),
    isActive: v.isActive,
    attributes: v.attributes.map(toDefinition),
    instanceAttributes: v.instanceAttributes.map(toInstanceDefinition),
  }
}
