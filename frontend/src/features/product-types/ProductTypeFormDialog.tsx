import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import type { ProductType, ProductTypeInput } from '@/api/generated/model'
import {
  getListProductTypesQueryKey,
  getListProductTypesQueryOptions,
  useCreateProductType,
  useUpdateProductType,
} from '@/api/generated/product-types/product-types'
import { invalidateProductQueries } from '@/catalog/invalidate'
import {
  apiFields,
  Button,
  CheckboxField,
  ColorField,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  setApiFieldErrors,
  TypeBadge,
  useFieldError,
} from '@/components/ui'

/** Limits of the API. */
const limits = { key: 64, name: 100, abbreviation: 6 }

/**
 * The abbreviation as the server stores it (D101): Unicode NFC, trimmed,
 * upper case per character like Go's strings.ToUpper (a character whose
 * upper case is longer, such as "ß", stays as it is). For the preview only;
 * the form sends the text as typed (trimmed) and the server normalises it.
 */
const normalizedAbbreviation = (s: string) =>
  [...s.normalize('NFC').trim()]
    .map((c) => {
      const upper = c.toUpperCase()
      return [...upper].length === 1 ? upper : c
    })
    .join('')
/** Characters (code points), as the server counts them. */
const characters = (s: string) => [...s.normalize('NFC').trim()].length

const schema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, errorKey('product_type.key_format'))
    .max(limits.key, errorKey('validation.too_long', { max: limits.key })),
  nameEn: z
    .string()
    .trim()
    .min(1, errorKey('validation.required'))
    .max(limits.name, errorKey('validation.too_long', { max: limits.name })),
  nameDe: z.string().trim().max(limits.name, errorKey('validation.too_long', { max: limits.name })),
  abbreviation: z
    .string()
    .trim()
    .refine((v) => characters(v) <= limits.abbreviation, errorKey('validation.too_long', { max: limits.abbreviation })),
  color: z
    .string()
    .trim()
    .regex(/^(#[0-9a-fA-F]{6})?$/, errorKey('product_type.color_format')),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['key', 'abbreviation', 'color', 'isActive'], { 'name.en': 'nameEn', 'name.de': 'nameDe' })

const toFormValues = (item: ProductType | null): FormValues => ({
  key: item?.key ?? '',
  nameEn: item?.name.en ?? '',
  nameDe: item?.name.de ?? '',
  abbreviation: item?.abbreviation ?? '',
  color: item?.color ?? '',
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): ProductTypeInput => {
  const abbreviation = v.abbreviation.trim()
  const color = v.color.trim().toLowerCase()
  return {
    key: v.key,
    name: { en: v.nameEn, ...(v.nameDe ? { de: v.nameDe } : {}) },
    ...(abbreviation ? { abbreviation } : {}),
    ...(color ? { color } : {}),
    isActive: v.isActive,
  }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: ProductType | null
}

/**
 * Creates or edits a product type (a system or product line such as Zigbee):
 * key, name, badge abbreviation and colour with a preview, active flag. An
 * update sends the version it was opened with as expectedUpdatedAt (D37); on
 * product_type.stale, Reload starts over from the current version.
 */
export function ProductTypeFormDialog({ open, onOpenChange, item }: Props) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateProductType()
  const update = useUpdateProductType()
  // The version being edited: the item the dialog was opened with, until
  // Reload replaces it with the current one.
  const [base, setBase] = useState<ProductType | null>(item)
  const [openedWith, setOpenedWith] = useState({ open, item })
  if (openedWith.open !== open || openedWith.item !== item) {
    setOpenedWith({ open, item })
    if (open) setBase(item)
  }
  const mutation = base ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(item) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset(toFormValues(item))
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const [nameEn, abbreviation, color] = useWatch({ control: form.control, name: ['nameEn', 'abbreviation', 'color'] })
  const previewColor = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : undefined

  const submit = form.handleSubmit(async (values) => {
    const data = toInput(values)
    try {
      if (base) await update.mutateAsync({ id: base.id, data: { ...data, expectedUpdatedAt: base.updatedAt } })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      // A taken key comes without a location (409), but belongs to the Key field.
      if (error instanceof ApiError && error.code === 'product_type.key_taken') {
        form.setError('key', { type: 'server', message: errorKey('product_type.key_taken', { key: values.key }) })
      }
      return // shown by ErrorMessage via mutation.error
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() }), invalidateProductQueries(queryClient)])
    onOpenChange(false)
  })

  // Starts over from the current version; the edits are discarded (the
  // message says to make them again).
  const reload = async () => {
    if (!base) return
    const all = await queryClient.fetchQuery({ ...getListProductTypesQueryOptions({ includeInactive: true }), staleTime: 0 })
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    const current = all.items.find((p) => p.id === base.id)
    if (!current) {
      onOpenChange(false)
      return
    }
    setBase(current)
    reset(toFormValues(current))
    resetUpdate()
  }
  const stale = mutation.error instanceof ApiError && mutation.error.code === 'product_type.stale'

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={fields}
          action={
            stale && (
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                <RotateCw /> {tCommon('action.reload')}
              </Button>
            )
          }
        />
      }
    >
      <Field label={t('field.key')} hint={t('field.keyHint')} error={fieldError(errors.key?.message)} {...form.register('key')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('field.nameEn')} error={fieldError(errors.nameEn?.message)} {...form.register('nameEn')} />
        <Field label={t('field.nameDe')} error={fieldError(errors.nameDe?.message)} {...form.register('nameDe')} />
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field
          label={t('field.abbreviation')}
          hint={t('field.abbreviationHint')}
          error={fieldError(errors.abbreviation?.message)}
          autoComplete="off"
          spellCheck={false}
          {...form.register('abbreviation')}
        />
        <Controller
          control={form.control}
          name="color"
          render={({ field, fieldState }) => (
            <ColorField
              label={t('field.color')}
              hint={t('field.colorHint')}
              error={fieldError(fieldState.error?.message)}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('field.preview')}</p>
        <div data-testid="badge-preview" className="rounded-control border border-line bg-canvas px-3 py-2 text-sm">
          <TypeBadge color={previewColor} abbreviation={normalizedAbbreviation(abbreviation)}>
            {nameEn.trim() || t('field.previewName')}
          </TypeBadge>
        </div>
      </div>
      <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
