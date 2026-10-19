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
import { formatDecimal, parseDecimal } from '@/catalog/decimal'
import { pricePattern } from '@/catalog/money'
import {
  type ApiFieldMap,
  errorKey,
  fromTranslatable,
  optionalTranslatable,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
} from '@/components/ui'

// The product and variant forms mirror the API body (name.en, price, ...), so
// field error locations map 1:1; attribute values live under `values.<key>`
// and stored values outside the schema under `keep.<key>` (D55). The server
// is the authority on every rule; these checks only catch the obvious
// mistakes before a round trip, with the server's codes and limits.

/** Limits of the API (D50, D51). */
export const limits = { modelNumber: 100, name: 200, description: 5000, variantName: 100, sku: 100 }

const tooLong = (max: number) => errorKey('validation.too_long', { max })
const requiredText = (max: number) => translatableSchema({ max, required: errorKey('validation.required') })
const attributeValues = z.record(z.string(), z.custom<AttributeFormValue>())
/** Per stored key outside the schema: sent back (true) or removed (false). */
const keep = z.record(z.string(), z.boolean())

export const productSchema = z.object({
  productTypeId: z.string().min(1, errorKey('validation.required')),
  categoryId: z.string().min(1, errorKey('validation.required')),
  modelNumber: z
    .string()
    .refine((v) => v.trim() !== '', errorKey('validation.required'))
    .refine((v) => v.trim().length <= limits.modelNumber, tooLong(limits.modelNumber)),
  name: requiredText(limits.name),
  description: translatableSchema({ max: limits.description }),
  isActive: z.boolean(),
  /** The mounting override; '' = as the category (D294). */
  mounting: z.string(),
  values: attributeValues,
  keep,
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

/** Every stored value of a product or variant: the schema's and the stale ones. */
export const storedValues = (item: Product | Variant | null): Record<string, unknown> =>
  item ? { ...item.attributes, ...item.staleAttributes } : {}

const keepAll = (stored: Record<string, unknown>) => Object.fromEntries(Object.keys(stored).map((k) => [k, true]))

/** `separator`: the UI language's decimal separator, which number inputs show ("2,5"). */
export function toProductFormValues(item: Product | null, defs: Definition[], separator: ',' | '.' = '.'): ProductFormValues {
  return {
    productTypeId: item?.productTypeId ?? '',
    categoryId: item?.categoryId ?? '',
    modelNumber: item?.modelNumber ?? '',
    name: toTranslatable(item?.name),
    description: toTranslatable(item?.description),
    isActive: item?.isActive ?? true,
    mounting: item?.mounting ?? '',
    values: toFormValues(defs, item?.attributes, separator),
    keep: keepAll(storedValues(item)),
  }
}

/** `separator`: the UI language's decimal separator, which the price and number inputs show ("27,50"). */
export function toVariantFormValues(item: Variant | null, defs: Definition[], separator: ',' | '.' = '.'): VariantFormValues {
  return {
    name: toTranslatable(item?.name),
    sku: item?.sku ?? '',
    price: item?.price ? formatDecimal(item.price, separator) : '',
    imageFileId: item?.imageFileId ?? '',
    isActive: item?.isActive ?? true,
    values: toFormValues(defs, item?.attributes, separator),
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
  const description = optionalTranslatable(v.description)
  return {
    productTypeId: v.productTypeId,
    categoryId: v.categoryId,
    modelNumber: v.modelNumber.trim(),
    name: fromTranslatable(v.name),
    ...(description ? { description } : {}),
    attributes,
    isActive: v.isActive,
    // Always sent: '' clears the override (D294).
    mounting: v.mounting,
  }
}

export function toVariantInput(v: VariantFormValues, attributes: Record<string, unknown>): VariantInput {
  const sku = v.sku.trim()
  return {
    name: fromTranslatable(v.name),
    ...(sku ? { sku } : {}),
    // Checked by the schema; the text as typed only if it is not a price (the server then says so).
    price: apiPrice(v.price) ?? v.price.trim(),
    // Leaving it out clears the image.
    ...(v.imageFileId ? { imageFileId: v.imageFileId } : {}),
    attributes,
    isActive: v.isActive,
  }
}

const productFields = ['productTypeId', 'categoryId', 'modelNumber', 'mounting']
const variantFields = ['sku', 'price', 'imageFileId']

/** API error locations shown at the form's fields, for the definitions shown and the stored values outside them. */
export function editorFields(kind: 'product' | 'variant', defs: Definition[], values: AttributeFormValues, stored: Record<string, unknown>): ApiFieldMap {
  const own = Object.fromEntries((kind === 'product' ? productFields : variantFields).map((f) => [f, f]))
  const texts =
    kind === 'product' ? { ...translatableApiFields('name'), ...translatableApiFields('description') } : translatableApiFields('name')
  return { ...own, ...texts, ...attributeFieldMap(defs, values, extraKeys(defs, stored)) }
}
