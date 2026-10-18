import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import {
  getListProductTypesQueryKey,
  useCreateProductType,
  useUpdateProductType,
} from '@/api/generated/product-types/product-types'
import type { ProductType } from '@/api/generated/model'
import { apiFields, errorKey, ErrorMessage, Field, FormDialog, setApiFieldErrors, useFieldError } from '@/components/ui'

const schema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, errorKey('product_type.key_format')).max(64, errorKey('validation.too_long')),
  nameEn: z.string().trim().min(1, errorKey('validation.required')),
  nameDe: z.string().trim(),
})
type FormValues = z.infer<typeof schema>

// API error locations shown at the form's fields.
const fields = apiFields<FormValues>(['key'], { 'name.en': 'nameEn', 'name.de': 'nameDe' })

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: ProductType | null
}

export function ProductTypeFormDialog({ open, onOpenChange, item }: Props) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateProductType()
  const update = useUpdateProductType()
  const mutation = item ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({ key: item?.key ?? '', nameEn: item?.name.en ?? '', nameDe: item?.name.de ?? '' })
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (values) => {
    // Placeholder until the product type editor page exists: keeps the rest unchanged.
    const data = {
      key: values.key,
      name: { en: values.nameEn, ...(values.nameDe ? { de: values.nameDe } : {}) },
      description: item?.description,
      isActive: item?.isActive ?? true,
      attributes: item?.attributes ?? [],
      instanceAttributes: item?.instanceAttributes ?? [],
    }
    try {
      if (item) await update.mutateAsync({ id: item.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <Field label={t('field.key')} error={fieldError(errors.key?.message)} {...form.register('key')} />
      <Field label={t('field.nameEn')} error={fieldError(errors.nameEn?.message)} {...form.register('nameEn')} />
      <Field label={t('field.nameDe')} error={fieldError(errors.nameDe?.message)} {...form.register('nameDe')} />
    </FormDialog>
  )
}
