import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { useLocalized } from '@/i18n/localized'
import {
  getListFunctionTypesQueryKey,
  useCreateFunctionType,
  useUpdateFunctionType,
} from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { FunctionType } from '@/api/generated/model'
import {
  apiFields,
  CheckboxGroupField,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  FormTranslatableField,
  fromTranslatable,
  setApiFieldErrors,
  SwitchField,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
  useFieldError,
} from '@/components/ui'

const schema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, errorKey('function_type.key_format')).max(64, errorKey('validation.too_long', { max: 64 })),
  name: translatableSchema({ required: errorKey('validation.required') }),
  allowsCircuit: z.boolean(),
  loadTypeIds: z.array(z.string()),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const fields = { ...apiFields<FormValues>(['key', 'loadTypeIds', 'isActive']), ...translatableApiFields('name') }

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
  const localized = useLocalized()
  // Inactive load types stay listed: a function type may still allow one.
  const loadTypes = useListLoadTypes({ includeInactive: true }, { query: { enabled: open } })
  const loadTypeOptions = (loadTypes.data?.items ?? []).map((l) => ({ value: l.id, label: localized(l.name) }))

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
      name: toTranslatable(functionType?.name),
      allowsCircuit: functionType?.allowsCircuit ?? false,
      loadTypeIds: functionType?.loadTypeIds ?? [],
      isActive: functionType?.isActive ?? true,
    })
    resetCreate()
    resetUpdate()
  }, [open, functionType, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (values) => {
    const data = {
      key: values.key,
      name: fromTranslatable(values.name),
      allowsCircuit: values.allowsCircuit,
      loadTypeIds: values.loadTypeIds,
      isActive: values.isActive,
    }
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
      <Field label={t('field.key')} hint={t('field.keyHint')} required autoComplete="off" error={fieldError(errors.key?.message)} {...form.register('key')} />
      <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
      <Controller
        control={form.control}
        name="loadTypeIds"
        render={({ field }) => (
          <CheckboxGroupField
            label={t('field.loadTypes')}
            hint={t('field.loadTypesHint')}
            options={loadTypeOptions}
            value={field.value}
            onChange={field.onChange}
            error={fieldError(errors.loadTypeIds?.message)}
          />
        )}
      />
      <SwitchField label={t('field.allowsCircuit')} hint={t('field.allowsCircuitHint')} {...form.register('allowsCircuit')} />
      <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
