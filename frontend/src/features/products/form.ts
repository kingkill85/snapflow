import { z } from 'zod'

import type { Product, ProductInput, Variant, VariantInput } from '@/api/generated/model'
import {
  type AttributeFormValue,
  type AttributeFormValues,
  attributeFieldMap,
  type Definition,
  extraKeys,
  toApiValues,
  toFormValues,
} from '@/catalog/attribute-values'
import { parseDecimal } from '@/catalog/decimal'
import { pricePattern } from '@/catalog/money'
import { type ApiFieldMap, errorKey } from '@/components/ui'

// The product and variant forms mirror the API body (name.en, price, ...), so
// field error locations map 1:1; attribute values live under `values.<key>`
// and stored values outside the schema under `keep.<key>` (D55). The server
// is the authority on every rule; these checks only catch the obvious
// mistakes before a round trip, with the server's codes and limits.

/** Limits of the API (D50, D51). */
export const limits = { modelNumber: 100, name: 200, description: 5000, variantName: 100, sku: 100 }

const tooLong = (max: number) => errorKey('validation.too_long', { max })
const text = (max: number) => z.object({ en: z.string().max(max, tooLong(max)), de: z.string().max(max, tooLong(max)) })
const requiredText = (max: number) =>
  z.object({
    en: z
      .string()
      .max(max, tooLong(max))
      .refine((v) => v.trim() !== '', errorKey('validation.required')),
    de: z.string().max(max, tooLong(max)),
  })
const attributeValues = z.record(z.string(), z.custom<AttributeFormValue>())
/** Per stored key outside the schema: sent back (true) or removed (false). */
const keep = z.record(z.string(), z.boolean())

export const productSchema = z
  .object({
    productTypeId: z.string().min(1, errorKey('validation.required')),
    modelNumber: z
      .string()
      .refine((v) => v.trim() !== '', errorKey('validation.required'))
      .refine((v) => v.trim().length <= limits.modelNumber, tooLong(limits.modelNumber)),
    name: requiredText(limits.name),
    description: text(limits.description),
    isActive: z.boolean(),
    values: attributeValues,
    keep,
  })
  .superRefine((v, ctx) => {
    if (v.description.de.trim() !== '' && v.description.en.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['description', 'en'], message: errorKey('validation.required') })
    }
  })
export type ProductFormValues = z.infer<typeof productSchema>

/** A typed price ("27,50" or "27.50") in the API's format, or undefined if it is not one (D52, D71). */
export function apiPrice(text: string): string | undefined {
  const decimal = parseDecimal(text)
  return decimal !== undefined && pricePattern.test(decimal) ? decimal : undefined
}

export const variantSchema = z.object({
  name: requiredText(limits.variantName),
  sku: z.string().refine((v) => v.trim().length <= limits.sku, tooLong(limits.sku)),
  price: z
    .string()
    .refine((v) => v.trim() !== '', errorKey('validation.required'))
    .refine((v) => v.trim() === '' || apiPrice(v) !== undefined, errorKey('variant.price_format')),
  imageFileId: z.string(),
  isActive: z.boolean(),
  values: attributeValues,
  keep,
})
export type VariantFormValues = z.infer<typeof variantSchema>

const textValues = (t?: { [locale: string]: string }) => ({ en: t?.en ?? '', de: t?.de ?? '' })
/** {en, de} without a blank German text. */
const localized = (t: { en: string; de: string }) => ({ en: t.en, ...(t.de.trim() ? { de: t.de } : {}) })
/** Like localized, but nothing when both are blank. */
const optionalLocalized = (t: { en: string; de: string }) => (t.en.trim() || t.de.trim() ? localized(t) : undefined)

/** Every stored value of a product or variant: the schema's and the stale ones. */
export const storedValues = (item: Product | Variant | null): Record<string, unknown> =>
  item ? { ...item.attributes, ...item.staleAttributes } : {}

const keepAll = (stored: Record<string, unknown>) => Object.fromEntries(Object.keys(stored).map((k) => [k, true]))

export function toProductFormValues(item: Product | null, defs: Definition[]): ProductFormValues {
  return {
    productTypeId: item?.productTypeId ?? '',
    modelNumber: item?.modelNumber ?? '',
    name: textValues(item?.name),
    description: textValues(item?.description),
    isActive: item?.isActive ?? true,
    values: toFormValues(defs, item?.attributes),
    keep: keepAll(storedValues(item)),
  }
}

export function toVariantFormValues(item: Variant | null, defs: Definition[]): VariantFormValues {
  return {
    name: textValues(item?.name),
    sku: item?.sku ?? '',
    price: item?.price ?? '',
    imageFileId: item?.imageFileId ?? '',
    isActive: item?.isActive ?? true,
    values: toFormValues(defs, item?.attributes),
    keep: keepAll(storedValues(item)),
  }
}

/**
 * The API attributes for a form: the definitions' values, plus the stored
 * values outside the schema that were not removed, unchanged (D55). `errors`:
 * inputs that are not numbers, by form field.
 */
export function toAttributes(defs: Definition[], values: AttributeFormValues, keepFlags: Record<string, boolean>, stored: Record<string, unknown>) {
  const { attributes, errors } = toApiValues(defs, values)
  for (const k of extraKeys(defs, stored)) if (keepFlags[k] !== false) attributes[k] = stored[k]
  return { attributes, errors: Object.entries(errors).map(([key, message]) => ({ name: `values.${key}` as const, message })) }
}

export function toProductInput(v: ProductFormValues, attributes: Record<string, unknown>): ProductInput {
  const description = optionalLocalized(v.description)
  return {
    productTypeId: v.productTypeId,
    modelNumber: v.modelNumber.trim(),
    name: localized(v.name),
    ...(description ? { description } : {}),
    attributes,
    isActive: v.isActive,
  }
}

export function toVariantInput(v: VariantFormValues, attributes: Record<string, unknown>): VariantInput {
  const sku = v.sku.trim()
  return {
    name: localized(v.name),
    ...(sku ? { sku } : {}),
    // Checked by the schema; the text as typed only if it is not a price (the server then says so).
    price: apiPrice(v.price) ?? v.price.trim(),
    // Leaving it out clears the image.
    ...(v.imageFileId ? { imageFileId: v.imageFileId } : {}),
    attributes,
    isActive: v.isActive,
  }
}

const productFields = ['productTypeId', 'modelNumber', 'name.en', 'name.de', 'description.en', 'description.de']
const variantFields = ['name.en', 'name.de', 'sku', 'price', 'imageFileId']

/** API error locations shown at the form's fields, for the definitions shown and the stored values outside them. */
export function editorFields(kind: 'product' | 'variant', defs: Definition[], values: AttributeFormValues, stored: Record<string, unknown>): ApiFieldMap {
  const own = Object.fromEntries((kind === 'product' ? productFields : variantFields).map((f) => [f, f]))
  return { ...own, ...attributeFieldMap(defs, values, extraKeys(defs, stored)) }
}
