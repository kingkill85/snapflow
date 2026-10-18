import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import {
  getListFunctionTypesQueryKey,
  useCreateFunctionType,
  useUpdateFunctionType,
} from '@/api/generated/function-types/function-types'
import type { FunctionType } from '@/api/generated/model'
import { apiFields, errorKey, ErrorMessage, Field, FormDialog, setApiFieldErrors, useFieldError } from '@/components/ui'

const schema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, errorKey('function_type.key_format')).max(64, errorKey('validation.too_long')),
  nameEn: z.string().trim().min(1, errorKey('validation.required')),
  nameDe: z.string().trim(),
})
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['key'], { 'name.en': 'nameEn', 'name.de': 'nameDe' })

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  functionType: FunctionType | null
}

export function FunctionTypeFormDialog({ open, onOpenChange, functionType }: Props) {
  const { t } = useTranslation('functionTypes')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateFunctionType()
  const update = useUpdateFunctionType()
  const mutation = functionType ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({
      key: functionType?.key ?? '',
      nameEn: functionType?.name.en ?? '',
      nameDe: functionType?.name.de ?? '',
    })
    resetCreate()
    resetUpdate()
  }, [open, functionType, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (values) => {
    const data = { key: values.key, name: { en: values.nameEn, ...(values.nameDe ? { de: values.nameDe } : {}) } }
    try {
      if (functionType) await update.mutateAsync({ id: functionType.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListFunctionTypesQueryKey() })
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={functionType ? t('edit') : t('new')}
      submitLabel={functionType ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <Field label={t('field.key')} hint={t('field.keyHint')} error={fieldError(errors.key?.message)} {...form.register('key')} />
      <Field label={t('field.nameEn')} error={fieldError(errors.nameEn?.message)} {...form.register('nameEn')} />
      <Field label={t('field.nameDe')} error={fieldError(errors.nameDe?.message)} {...form.register('nameDe')} />
    </FormDialog>
  )
}
