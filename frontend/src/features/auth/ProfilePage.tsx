import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { z } from 'zod'

import { useChangePassword, useLogoutAll, useUpdateMe } from '@/api/generated/auth/auth'
import { getListUsersQueryKey } from '@/api/generated/users/users'
import { useMe, useSetMe } from '@/app/session'
import {
  apiFields,
  Button,
  ConfirmDialog,
  errorKey,
  ErrorMessage,
  Field,
  Notice,
  Page,
  Section,
  setApiFieldErrors,
  useFieldError,
} from '@/components/ui'

const detailsSchema = z.object({
  fullName: z.string().trim().max(200, errorKey('validation.too_long', { max: 200 })),
  email: z.email(errorKey('validation.email')).max(254, errorKey('validation.too_long', { max: 254 })),
})
type DetailsValues = z.infer<typeof detailsSchema>
const detailsFields = apiFields<DetailsValues>(['fullName', 'email'])

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, errorKey('validation.required')).max(200, errorKey('validation.too_long', { max: 200 })),
    newPassword: z.string().min(8, errorKey('user.password_too_short')).max(200, errorKey('validation.too_long', { max: 200 })),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: errorKey('validation.password_mismatch'), path: ['confirmPassword'] })
type PasswordValues = z.infer<typeof passwordSchema>
const passwordFields = apiFields<PasswordValues>(['currentPassword', 'newPassword'])

export function ProfilePage() {
  const { t } = useTranslation('auth')
  const { t: tCommon } = useTranslation()
  const me = useMe()

  return (
    <Page title={t('profile.title')} description={`${tCommon(`role.${me.role}`)} · ${me.tenantName}`}>
      <div className="grid gap-6 lg:grid-cols-2">
        <DetailsForm />
        <PasswordForm />
        <Sessions />
      </div>
    </Page>
  )
}

function DetailsForm() {
  const { t } = useTranslation('auth')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const me = useMe()
  const setMe = useSetMe()
  const queryClient = useQueryClient()
  const update = useUpdateMe()

  const form = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { fullName: me.fullName, email: me.email },
  })
  const { errors } = form.formState

  const submit = form.handleSubmit(async (data) => {
    try {
      setMe(await update.mutateAsync({ data }))
    } catch (error) {
      setApiFieldErrors(error, form.setError, detailsFields)
      return // shown by ErrorMessage via update.error
    }
    // The user list shows the name and email too.
    await queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })
  })

  return (
    <Section title={t('profile.details')} description={t('profile.detailsDescription')}>
      <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
        <ErrorMessage error={update.error} fields={detailsFields} />
        {update.isSuccess && <Notice>{tCommon('state.saved')}</Notice>}
        <Field label={t('profile.fullName')} autoComplete="name" error={fieldError(errors.fullName?.message)} {...form.register('fullName')} />
        <Field
          label={t('profile.email')}
          type="email"
          autoComplete="email"
          error={fieldError(errors.email?.message)}
          {...form.register('email')}
        />
        <Button type="submit" disabled={update.isPending}>
          {tCommon('action.save')}
        </Button>
      </form>
    </Section>
  )
}

function PasswordForm() {
  const { t } = useTranslation('auth')
  const fieldError = useFieldError()
  const change = useChangePassword()

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })
  const { errors } = form.formState

  const submit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await change.mutateAsync({ data: { currentPassword, newPassword } })
    } catch (error) {
      setApiFieldErrors(error, form.setError, passwordFields)
      return // shown by ErrorMessage via change.error
    }
    form.reset()
  })

  return (
    <Section title={t('profile.password')} description={t('profile.passwordDescription')}>
      <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
        <ErrorMessage error={change.error} fields={passwordFields} />
        {change.isSuccess && <Notice>{t('profile.passwordChanged')}</Notice>}
        <Field
          label={t('profile.currentPassword')}
          type="password"
          autoComplete="current-password"
          error={fieldError(errors.currentPassword?.message)}
          {...form.register('currentPassword')}
        />
        <Field
          label={t('profile.newPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('profile.newPasswordHint')}
          error={fieldError(errors.newPassword?.message)}
          {...form.register('newPassword')}
        />
        <Field
          label={t('profile.confirmPassword')}
          type="password"
          autoComplete="new-password"
          error={fieldError(errors.confirmPassword?.message)}
          {...form.register('confirmPassword')}
        />
        <Button type="submit" disabled={change.isPending}>
          {t('profile.changePassword')}
        </Button>
      </form>
    </Section>
  )
}

function Sessions() {
  const { t } = useTranslation('auth')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logoutAll = useLogoutAll()
  const [confirming, setConfirming] = useState(false)

  const open = () => {
    logoutAll.reset()
    setConfirming(true)
  }

  const signOutEverywhere = async () => {
    try {
      await logoutAll.mutateAsync()
    } catch {
      return // shown by ErrorMessage via logoutAll.error
    }
    // This session ended too: forget everything cached for this user.
    queryClient.clear()
    void navigate('/login', { replace: true })
  }

  return (
    <Section title={t('profile.sessions')} description={t('profile.sessionsDescription')}>
      <Button variant="secondary" onClick={open}>
        <LogOut /> {t('profile.signOutEverywhere')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('profile.signOutEverywhere')}
        message={t('profile.signOutEverywhereMessage')}
        confirmLabel={t('profile.signOutEverywhere')}
        pending={logoutAll.isPending}
        onConfirm={() => void signOutEverywhere()}
        error={<ErrorMessage error={logoutAll.error} />}
      />
    </Section>
  )
}
