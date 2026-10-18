import { ApiError } from '@/api/client'
import type { AttributeDefinition, FieldError, InstanceAttributeDefinition, ProductType } from '@/api/generated/model'
import { type ApiFieldMap, errorKey } from '@/components/ui'

import { parseDecimal } from './decimal'

// Attribute values as a form edits them, and back to what the API takes.
// Shared by the product and variant editors, later the import mapping (1d) and
// instances (phase 2). The server validates every value (attrschema); this
// only converts the inputs and catches text that is not a number (D23, D48).

/** One definition of a product type's (or instance) schema. */
export type Definition = AttributeDefinition | InstanceAttributeDefinition

/**
 * A stored value the definition's input cannot show without changing it (a
 * yes/no holding text, list items that are objects, an object as text): kept
 * as stored and sent back unchanged until the input is changed, so the
 * server's error stays visible and nothing is dropped silently (D67, D85).
 */
export type RawValue = { raw: unknown }

/**
 * An attribute value in a form: text, number, integer and enum as text ("" =
 * not set), boolean as true/false (null = not set), lists as text items, or a
 * stored value kept as it is (RawValue).
 */
export type AttributeFormValue = string | boolean | null | string[] | RawValue

export const isRaw = (v: unknown): v is RawValue => typeof v === 'object' && v !== null && !Array.isArray(v) && 'raw' in v

/** Attribute values by key, as a form edits them. */
export type AttributeFormValues = Record<string, AttributeFormValue>

/** The definitions of a product type that apply to products or to variants. */
export const definitionsFor = (type: ProductType | undefined, scope: 'product' | 'variant'): AttributeDefinition[] =>
  (type?.attributes ?? []).filter((a) => (a.scope ?? 'product') === scope)

/** A definition's empty value; a required yes/no starts as "no", since a checkbox has no "not set". */
export const emptyValue = (d: Definition): AttributeFormValue =>
  d.type === 'list' ? [] : d.type === 'boolean' ? (d.required ? false : null) : ''

const isObject = (v: unknown) => typeof v === 'object' && v !== null
/** Text of a scalar; also used to show raw values. */
export const scalarText = (v: unknown) => (isObject(v) ? JSON.stringify(v) : String(v))

/**
 * A value in the shape a definition's input edits. Values stored for another
 * type (e.g. after the schema changed) are converted as well as possible, so
 * nothing is hidden; the server reports what does not fit. What the input
 * cannot hold without changing it is kept raw (RawValue).
 */
export function toFormValue(d: Definition, v: unknown): AttributeFormValue {
  if (v === undefined || v === null || v === '') return emptyValue(d)
  if (d.type === 'boolean') return typeof v === 'boolean' ? v : { raw: v }
  if (d.type === 'list') {
    if (!Array.isArray(v)) return isObject(v) ? { raw: v } : [scalarText(v)]
    return v.some(isObject) ? { raw: v } : v.map(scalarText)
  }
  if (Array.isArray(v)) return v.some(isObject) ? { raw: v } : v.map(scalarText).join(', ')
  return isObject(v) ? { raw: v } : scalarText(v)
}

/** The form value of a definition: the edited one, or the empty one for a key not edited yet. */
export function formValueOf(d: Definition, values: AttributeFormValues): AttributeFormValue {
  const v = values[d.key]
  if (v === undefined) return emptyValue(d)
  // Kept as stored, whatever the definition (until the input changes it).
  if (isRaw(v)) return v
  // A key edited under another definition (e.g. before the product type changed).
  if (d.type === 'list') return Array.isArray(v) ? v : v === null || v === '' ? [] : [String(v)]
  if (d.type === 'boolean') return typeof v === 'boolean' ? v : emptyValue(d)
  return Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
}

/** What an input shows for a raw value: list items as text, other values as one text. */
export const rawItems = (v: RawValue): string[] => (Array.isArray(v.raw) ? v.raw.map(scalarText) : [scalarText(v.raw)])

/** The form values for stored values: one per definition. */
export function toFormValues(defs: Definition[], stored: Record<string, unknown> | undefined): AttributeFormValues {
  return Object.fromEntries(defs.map((d) => [d.key, toFormValue(d, stored?.[d.key])]))
}

type Converted = { value?: unknown; error?: string }

function scalarValue(type: Definition['type'], text: string): Converted {
  const v = text.trim()
  if (v === '') return {}
  if (type !== 'number' && type !== 'integer') return { value: v }
  // "27,5" and "27.5" alike; no exponents, hex or binary forms (D71).
  const decimal = parseDecimal(v)
  const n = decimal === undefined ? Number.NaN : Number(decimal)
  if (!Number.isFinite(n)) return { error: errorKey('validation.number') }
  if (type === 'integer' && !Number.isInteger(n)) return { error: errorKey('attribute.type', { expected: 'integer' }) }
  return { value: n }
}

/** A form value as the API takes it: nothing when not set, or the error of input that is not a number. */
export function toApiValue(d: Definition, v: AttributeFormValue): Converted {
  if (isRaw(v)) return { value: v.raw }
  if (d.type === 'boolean') return typeof v === 'boolean' ? { value: v } : {}
  if (d.type === 'list') {
    const items: unknown[] = []
    for (const item of Array.isArray(v) ? v : []) {
      const converted = scalarValue(d.itemType ?? 'text', item)
      if (converted.error) return converted
      if (converted.value !== undefined) items.push(converted.value)
    }
    return items.length > 0 ? { value: items } : {}
  }
  return scalarValue(d.type, Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '')
}

/**
 * The API values of the definitions (keys not set are left out) and the
 * input errors by key (form messages, see errorKey).
 */
export function toApiValues(defs: Definition[], values: AttributeFormValues) {
  const attributes: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const d of defs) {
    const { value, error } = toApiValue(d, formValueOf(d, values))
    if (error) errors[d.key] = error
    else if (value !== undefined) attributes[d.key] = value
  }
  return { attributes, errors }
}

/**
 * Stored values the definitions do not cover: keys the schema no longer has
 * (stale) and keys of the other scope. They are shown with a Remove action
 * and sent back unchanged unless removed (D55).
 */
export const extraKeys = (defs: Definition[], stored: Record<string, unknown>) => {
  const known = new Set(defs.map((d) => d.key))
  return Object.keys(stored)
    .filter((k) => !known.has(k))
    .sort()
}

/**
 * Where a form shows the API's errors of attribute values: each definition's
 * value at `${valuesField}.<key>` (list items there too) and each extra
 * value at `${extraField}.<key>`. `location` is the body field, e.g. "attributes".
 */
export function attributeFieldMap(
  defs: Definition[],
  values: AttributeFormValues,
  extras: string[],
  { location = 'attributes', valuesField = 'values', extraField = 'keep' } = {},
): ApiFieldMap {
  const map: Record<string, string> = {}
  for (const d of defs) {
    map[`${location}.${d.key}`] = `${valuesField}.${d.key}`
    if (d.type !== 'list') continue
    const v = formValueOf(d, values)
    const count = Array.isArray(v) ? v.length : isRaw(v) && Array.isArray(v.raw) ? v.raw.length : 0
    for (let i = 0; i < count; i++) map[`${location}.${d.key}[${i}]`] = `${valuesField}.${d.key}`
  }
  for (const k of extras) map[`${location}.${k}`] = `${extraField}.${k}`
  return map
}

/** Problems of stored values (attributeErrors of a read) as an API error, to show them like a failed save's. */
export const storedValueErrors = (errors: FieldError[]) =>
  new ApiError({ status: 422, code: 'validation.failed', fields: errors.map((e) => ({ ...e, location: `body.${e.location}` })) })
