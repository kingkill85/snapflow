import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import { getListUsersQueryKey, useCreateUser, useUpdateUser } from '@/api/generated/users/users'
import { Role, type Tenant, type User } from '@/api/generated/model'
import { useMe } from '@/app/session'
import { CheckboxField, ErrorMessage, Field, FormDialog, SelectField } from '@/components/ui'

const schema = z.object({
  email: z.email('validation.email'),
  fullName: z.string().trim(),
  role: z.enum(Role),
  tenantId: z.string(),
  isActive: z.boolean(),
  password: z.string().refine((v) => v === '' || v.length >= 8, 'user.password_too_short'),
})
type FormValues = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: User | null
  /** Tenants to choose from; empty when the caller manages only their own. */
  tenants: Tenant[]
  /** Preselected tenant for new users. */
  defaultTenantId: string
}

export function UserFormDialog({ open, onOpenChange, item, tenants, defaultTenantId }: Props) {
  const { t } = useTranslation('users')
  const { t: tCommon } = useTranslation()
  const { t: tError } = useTranslation('errors')
  const me = useMe()
  const queryClient = useQueryClient()
  const create = useCreateUser()
  const update = useUpdateUser()
  const mutation = item ? update : create

  // Nobody changes their own role, tenant or status; those fields keep their values.
  const isSelf = item?.id === me.id

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({
      email: item?.email ?? '',
      fullName: item?.fullName ?? '',
      role: item?.role ?? Role.user,
      tenantId: item?.tenantId ?? defaultTenantId,
      isActive: item?.isActive ?? true,
      password: '',
    })
    resetCreate()
    resetUpdate()
  }, [open, item, defaultTenantId, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async ({ password, ...values }) => {
    if (!item && password === '') {
      form.setError('password', { message: 'validation.required' })
      return
    }
    const data = { ...values, ...(password ? { password } : {}) }
    try {
      if (item) await update.mutateAsync({ id: item.id, data })
      else await create.mutateAsync({ data })
    } catch {
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })
    if (isSelf) await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() })
    onOpenChange(false)
  })

  const fieldError = (message?: string) => (message ? tError(message as never) : undefined)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} />}
    >
      <Field label={t('field.email')} type="email" autoComplete="off" error={fieldError(errors.email?.message)} {...form.register('email')} />
      <Field label={t('field.fullName')} autoComplete="off" {...form.register('fullName')} />
      {!isSelf && (
        <SelectField
          label={t('field.role')}
          options={me.assignableRoles.map((r) => ({ value: r, label: tCommon(`role.${r}`) }))}
          {...form.register('role')}
        />
      )}
      {!isSelf && tenants.length > 0 && (
        <SelectField
          label={t('field.tenant')}
          options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
          {...form.register('tenantId')}
        />
      )}
      <Field
        label={t('field.password')}
        type="password"
        autoComplete="new-password"
        hint={item ? t('field.passwordResetHint') : t('field.passwordHint')}
        error={fieldError(errors.password?.message)}
        {...form.register('password')}
      />
      {!isSelf && <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />}
    </FormDialog>
  )
}
