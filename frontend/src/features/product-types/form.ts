import { z } from 'zod'

import {
  type AttributeDefinition,
  AttributeDefinitionItemType,
  AttributeDefinitionScope,
  AttributeDefinitionType,
  type ProductType,
  type ProductTypeInput,
} from '@/api/generated/model'
import { apiFields, errorKey } from '@/components/ui'

// The editor's form mirrors the API body (name.en, attributes.2.options.0.key, ...),
// so the API's field error locations map 1:1 to form fields. Numbers are edited
// as text and converted on save. The server is the authority on every rule; the
// checks here only catch the obvious mistakes before a round trip.

const keyPattern = /^[a-z][a-z0-9_]*$/
const key = (format: 'product_type.key_format' | 'attribute.key_format') =>
  z.string().max(64, errorKey('validation.too_long')).regex(keyPattern, errorKey(format))

const text = z.object({ en: z.string(), de: z.string() })
const requiredText = (message: 'validation.required' | 'attribute.label_required') =>
  z.object({ en: z.string().refine((v) => v.trim() !== '', errorKey(message)), de: z.string() })

/** Whether min/max apply to a type (value range, text length or item count). */
export const hasBounds = (type: AttributeDefinitionType) => type === 'text' || type === 'number' || type === 'integer' || type === 'list'

/** Whether an attribute row edits options (an enum, or a list of enums). */
export const hasOptions = (type: AttributeDefinitionType, itemType: AttributeDefinitionItemType) =>
  type === 'enum' || (type === 'list' && itemType === 'enum')

const isNumber = (v: string) => v.trim() !== '' && Number.isFinite(Number(v))

const attribute = z
  .object({
    key: key('attribute.key_format'),
    label: requiredText('attribute.label_required'),
    description: text,
    type: z.enum(AttributeDefinitionType),
    required: z.boolean(),
    unit: z.string().max(16, errorKey('validation.too_long')),
    scope: z.enum(AttributeDefinitionScope),
    min: z.string(),
    max: z.string(),
    itemType: z.enum(AttributeDefinitionItemType),
    options: z.array(z.object({ key: z.string(), label: text })),
  })
  .superRefine((a, ctx) => {
    if (a.description.de.trim() !== '' && a.description.en.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['description', 'en'], message: errorKey('validation.required') })
    }
    if (hasBounds(a.type)) {
      for (const bound of ['min', 'max'] as const) {
        if (a[bound].trim() !== '' && !isNumber(a[bound])) {
          ctx.addIssue({ code: 'custom', path: [bound], message: errorKey('validation.number') })
        }
      }
      if (isNumber(a.min) && isNumber(a.max) && Number(a.min) > Number(a.max)) {
        ctx.addIssue({ code: 'custom', path: ['max'], message: errorKey('validation.min_above_max') })
      }
    }
    if (hasOptions(a.type, a.itemType)) {
      if (a.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: errorKey('attribute.options_required') })
      }
      const seen = new Set<string>()
      a.options.forEach((o, j) => {
        if (!keyPattern.test(o.key)) {
          ctx.addIssue({ code: 'custom', path: ['options', j, 'key'], message: errorKey('attribute.key_format') })
        } else if (seen.has(o.key)) {
          ctx.addIssue({ code: 'custom', path: ['options', j, 'key'], message: errorKey('attribute.option_key_duplicate') })
        }
        seen.add(o.key)
        if (o.label.en.trim() === '') {
          ctx.addIssue({ code: 'custom', path: ['options', j, 'label', 'en'], message: errorKey('attribute.label_required') })
        }
      })
    }
  })

const schemaList = z.array(attribute).superRefine((list, ctx) => {
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
    key: key('product_type.key_format'),
    name: requiredText('validation.required'),
    description: text,
    isActive: z.boolean(),
    attributes: schemaList,
    instanceAttributes: schemaList,
  })
  .superRefine((v, ctx) => {
    if (v.description.de.trim() !== '' && v.description.en.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['description', 'en'], message: errorKey('validation.required') })
    }
  })

export type FormValues = z.infer<typeof formSchema>
export type AttributeValues = FormValues['attributes'][number]
/** The two attribute schemas of a product type. */
export type SchemaName = 'attributes' | 'instanceAttributes'

/** API error locations shown at the editor's fields. */
export const editorFields = apiFields<FormValues>(
  ['key', 'name.en', 'name.de', 'description.en', 'description.de'],
  {},
  ['attributes', 'instanceAttributes'],
)

export const emptyOption = (): AttributeValues['options'][number] => ({ key: '', label: { en: '', de: '' } })

export const emptyAttribute = (): AttributeValues => ({
  key: '',
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

const textValues = (t?: { [locale: string]: string }) => ({ en: t?.en ?? '', de: t?.de ?? '' })
const bound = (n?: number) => (n === undefined ? '' : String(n))

const toAttributeValues = (a: AttributeDefinition): AttributeValues => ({
  key: a.key,
  label: textValues(a.label),
  description: textValues(a.description),
  type: a.type,
  required: a.required ?? false,
  unit: a.unit ?? '',
  scope: a.scope ?? 'product',
  min: bound(a.min),
  max: bound(a.max),
  itemType: a.itemType ?? 'text',
  options: (a.options ?? []).map((o) => ({ key: o.key, label: textValues(o.label) })),
})

/** The form's values for a product type, or for a new one. */
export function toFormValues(item: ProductType | undefined): FormValues {
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

const toDefinition = (a: AttributeValues, schema: SchemaName): AttributeDefinition => {
  const description = optionalLocalized(a.description)
  return {
    key: a.key,
    label: localized(a.label),
    ...(description ? { description } : {}),
    type: a.type,
    required: a.required,
    ...(a.unit.trim() ? { unit: a.unit } : {}),
    ...(schema === 'attributes' ? { scope: a.scope } : {}),
    ...(hasBounds(a.type) && a.min.trim() ? { min: Number(a.min) } : {}),
    ...(hasBounds(a.type) && a.max.trim() ? { max: Number(a.max) } : {}),
    ...(a.type === 'list' ? { itemType: a.itemType } : {}),
    ...(hasOptions(a.type, a.itemType) ? { options: a.options.map((o) => ({ key: o.key, label: localized(o.label) })) } : {}),
  }
}

/** The API body for the form's values: only what applies to each attribute's type. */
export function toInput(v: FormValues): ProductTypeInput {
  const description = optionalLocalized(v.description)
  return {
    key: v.key,
    name: localized(v.name),
    ...(description ? { description } : {}),
    isActive: v.isActive,
    attributes: v.attributes.map((a) => toDefinition(a, 'attributes')),
    instanceAttributes: v.instanceAttributes.map((a) => toDefinition(a, 'instanceAttributes')),
  }
}
