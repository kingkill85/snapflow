import { z } from 'zod'

import { type CatalogField, type CatalogFieldInput, CatalogFieldInputMeaning, CatalogFieldInputType } from '@/api/generated/model'
import { apiFields, errorKey, fromTranslatable, toTranslatable, translatableApiFields, translatableSchema } from '@/components/ui'

const keyRule = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, errorKey('catalog_field.key_format'))
  .max(64, errorKey('validation.too_long', { max: 64 }))

export const catalogFieldSchema = z.object({
  key: keyRule,
  label: translatableSchema({
    max: 100,
    required: errorKey('validation.required'),
  }),
  type: z.enum(Object.values(CatalogFieldInputType) as [CatalogFieldInputType, ...CatalogFieldInputType[]]),
  unit: z
    .string()
    .trim()
    .max(16, errorKey('validation.too_long', { max: 16 })),
  options: z.array(
    z.object({
      key: keyRule,
      label: translatableSchema({
        max: 100,
        required: errorKey('validation.required'),
      }),
    }),
  ),
  etimFeature: z
    .string()
    .trim()
    .max(20, errorKey('validation.too_long', { max: 20 })),
  meaning: z.string(),
  outputKindId: z.string(),
  loadTypeId: z.string(),
  productTypeIds: z.array(z.string()),
})
export type CatalogFieldFormValues = z.infer<typeof catalogFieldSchema>

export const catalogFieldApiFields = {
  ...apiFields<CatalogFieldFormValues>(['key', 'type', 'unit', 'etimFeature', 'meaning', 'outputKindId', 'loadTypeId', 'productTypeIds'], {
    // The list's own error lives at its root (react-hook-form field arrays).
    options: 'options.root' as 'options',
  }),
  ...translatableApiFields('label'),
}

export const toCatalogFieldFormValues = (item: CatalogField | null): CatalogFieldFormValues => ({
  key: item?.key ?? '',
  label: toTranslatable(item?.label),
  type: item?.type ?? 'number',
  unit: item?.unit ?? '',
  options: (item?.options ?? []).map((o) => ({
    key: o.key,
    label: toTranslatable(o.label),
  })),
  etimFeature: item?.etimFeature ?? '',
  meaning: item?.meaning ?? '',
  outputKindId: item?.outputKindId ?? '',
  loadTypeId: item?.loadTypeId ?? '',
  productTypeIds: item?.productTypeIds ?? [],
})

/** The input sent: parameters only where the meaning has them. */
export const toCatalogFieldInput = (
  v: CatalogFieldFormValues,
  spec: { outputKind: boolean; loadType: boolean } | undefined,
): CatalogFieldInput => ({
  key: v.key,
  label: fromTranslatable(v.label),
  type: v.type,
  ...(v.unit.trim() ? { unit: v.unit.trim() } : {}),
  ...(v.type === 'enum'
    ? {
        options: v.options.map((o) => ({
          key: o.key,
          label: fromTranslatable(o.label),
        })),
      }
    : {}),
  ...(v.etimFeature.trim() ? { etimFeature: v.etimFeature.trim() } : {}),
  ...(v.meaning
    ? {
        meaning: v.meaning as CatalogFieldInputMeaning,
        ...(spec?.outputKind && v.outputKindId ? { outputKindId: v.outputKindId } : {}),
        ...(spec?.loadType && v.loadTypeId ? { loadTypeId: v.loadTypeId } : {}),
        productTypeIds: v.productTypeIds,
      }
    : {}),
})
