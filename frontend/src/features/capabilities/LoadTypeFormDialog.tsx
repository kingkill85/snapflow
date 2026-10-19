import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { getListLoadTypesQueryKey, useCreateLoadType, useUpdateLoadType } from '@/api/generated/load-types/load-types'
import type { LoadType, LoadTypeInput } from '@/api/generated/model'
import {
  apiFields,
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

import { StaleReload } from './StaleReload'

const schema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, errorKey('load_type.key_format'))
    .max(64, errorKey('validation.too_long', { max: 64 })),
  name: translatableSchema({
    max: 100,
    required: errorKey('validation.required'),
  }),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const fields = {
  ...apiFields<FormValues>(['key', 'isActive']),
  ...translatableApiFields('name'),
}

const toFormValues = (item: LoadType | null): FormValues => ({
  key: item?.key ?? '',
  name: toTranslatable(item?.name),
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): LoadTypeInput => ({
  key: v.key,
  name: fromTranslatable(v.name),
  isActive: v.isActive,
})

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: LoadType | null
  onSaved: () => Promise<unknown>
}

/** Creates or edits a load type (LED, halogen, …): key, name, active. */
export function LoadTypeFormDialog({ open, onOpenChange, item, onSaved }: Props) {
  const { t } = useTranslation('capabilities')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateLoadType()
  const update = useUpdateLoadType()
  const mutation = item ? update : create
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(item),
  })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset(toFormValues(item))
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (values) => {
    const data = toInput(values)
    try {
      if (item)
        await update.mutateAsync({
          id: item.id,
          data: { ...data, expectedUpdatedAt: item.updatedAt },
        })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      if (error instanceof ApiError && error.code === 'load_type.key_taken') {
        form.setError('key', {
          type: 'server',
          message: errorKey('load_type.key_taken', { key: values.key }),
        })
      }
      return
    }
    await onSaved()
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('loadTypes.edit') : t('loadTypes.new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={fields}
          action={
            <StaleReload
              error={mutation.error}
              code="load_type.stale"
              onReload={async () => {
                await queryClient.invalidateQueries({
                  queryKey: getListLoadTypesQueryKey(),
                })
                onOpenChange(false)
              }}
            />
          }
        />
      }
    >
      <Field
        label={t('field.key')}
        hint={t('loadTypes.keyHint')}
        required
        autoComplete="off"
        error={fieldError(errors.key?.message)}
        {...form.register('key')}
      />
      <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
      <SwitchField label={t('field.active')} hint={t('loadTypes.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
