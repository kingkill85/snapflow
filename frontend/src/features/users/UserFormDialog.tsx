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
import {
  apiFields,
  CheckboxField,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  SelectField,
  setApiFieldErrors,
  TextLink,
  useFieldError,
} from '@/components/ui'

const schema = z.object({
  email: z.email(errorKey('validation.email')).max(254, errorKey('validation.too_long')),
  fullName: z.string().trim().max(200, errorKey('validation.too_long')),
  role: z.enum(Role),
  tenantId: z.string(),
  isActive: z.boolean(),
  password: z
    .string()
    .refine((v) => v === '' || v.length >= 8, errorKey('user.password_too_short'))
    .max(200, errorKey('validation.too_long')),
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
  const fieldError = useFieldError()
  const me = useMe()
  const queryClient = useQueryClient()
  const create = useCreateUser()
  const update = useUpdateUser()
  const mutation = item ? update : create

  // Nobody changes their own role, tenant, status or password here; those
  // fields keep their values (the password is changed on the profile).
  const isSelf = item?.id === me.id
  const showTenant = !isSelf && tenants.length > 0
  // The fields this form renders, which show the API's per-field errors.
  const fields = apiFields<FormValues>(['email', 'fullName', !isSelf && 'role', showTenant && 'tenantId', !isSelf && 'password'])

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
      form.setError('password', { message: errorKey('validation.required') })
      return
    }
    const data = { ...values, ...(password ? { password } : {}) }
    try {
      if (item) await update.mutateAsync({ id: item.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })
    if (isSelf) await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() })
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
      <Field label={t('field.email')} type="email" autoComplete="off" error={fieldError(errors.email?.message)} {...form.register('email')} />
      <Field label={t('field.fullName')} autoComplete="off" error={fieldError(errors.fullName?.message)} {...form.register('fullName')} />
      {!isSelf && (
        <SelectField
          label={t('field.role')}
          options={me.assignableRoles.map((r) => ({ value: r, label: tCommon(`role.${r}`) }))}
          error={fieldError(errors.role?.message)}
          {...form.register('role')}
        />
      )}
      {showTenant && (
        <SelectField
          label={t('field.tenant')}
          options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
          error={fieldError(errors.tenantId?.message)}
          {...form.register('tenantId')}
        />
      )}
      {isSelf ? (
        <p className="text-sm text-muted">
          {t('field.ownPasswordHint')} <TextLink to="/profile">{t('field.openProfile')}</TextLink>
        </p>
      ) : (
        <Field
          label={t('field.password')}
          type="password"
          autoComplete="new-password"
          hint={item ? t('field.passwordResetHint') : t('field.passwordHint')}
          error={fieldError(errors.password?.message)}
          {...form.register('password')}
        />
      )}
      {!isSelf && <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />}
    </FormDialog>
  )
}
