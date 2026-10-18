import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import type { Tenant } from '@/api/generated/model'
import { getListTenantsQueryKey, useCreateTenant, useUpdateTenant } from '@/api/generated/tenants/tenants'
import { useMe } from '@/app/session'
import {
  apiFields,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  setApiFieldErrors,
  SwitchField,
  useFieldError,
} from '@/components/ui'

const schema = z.object({
  name: z.string().trim().min(1, errorKey('validation.required')).max(200, errorKey('validation.too_long', { max: 200 })),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['name'])

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: Tenant | null
}

export function TenantFormDialog({ open, onOpenChange, item }: Props) {
  const { t } = useTranslation('tenants')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const me = useMe()
  const queryClient = useQueryClient()
  const create = useCreateTenant()
  const update = useUpdateTenant()
  const mutation = item ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? '', isActive: item?.isActive ?? true })
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (data) => {
    try {
      if (item) await update.mutateAsync({ id: item.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
    // The session shows the user's own tenant name.
    if (item?.id === me.tenantId) await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() })
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
      <Field label={t('field.name')} required autoComplete="off" error={fieldError(errors.name?.message)} {...form.register('name')} />
      {item?.isDistributor ? (
        <p className="text-sm text-muted">{t('field.distributorHint')}</p>
      ) : (
        <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
      )}
    </FormDialog>
  )
}
