import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { useChangePassword, useUpdateMe } from '@/api/generated/auth/auth'
import { useMe, useSetMe } from '@/app/session'
import { Button, ErrorMessage, Field, Notice, Page, Section } from '@/components/ui'

const detailsSchema = z.object({
  fullName: z.string().trim(),
  email: z.email('validation.email'),
})

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'validation.required'),
    newPassword: z.string().min(8, 'user.password_too_short'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'validation.password_mismatch', path: ['confirmPassword'] })

export function ProfilePage() {
  const { t } = useTranslation('auth')
  const { t: tCommon } = useTranslation()
  const me = useMe()

  return (
    <Page title={t('profile.title')} description={`${tCommon(`role.${me.role}`)} · ${me.tenantName}`}>
      <div className="grid gap-6 lg:grid-cols-2">
        <DetailsForm />
        <PasswordForm />
      </div>
    </Page>
  )
}

function DetailsForm() {
  const { t } = useTranslation('auth')
  const { t: tCommon } = useTranslation()
  const { t: tError } = useTranslation('errors')
  const me = useMe()
  const setMe = useSetMe()
  const update = useUpdateMe()

  const form = useForm<z.infer<typeof detailsSchema>>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { fullName: me.fullName, email: me.email },
  })
  const { errors } = form.formState

  const submit = form.handleSubmit(async (data) => {
    try {
      setMe(await update.mutateAsync({ data }))
    } catch {
      return // shown by ErrorMessage via update.error
    }
  })

  return (
    <Section title={t('profile.details')} description={t('profile.detailsDescription')}>
      <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
        <ErrorMessage error={update.error} />
        {update.isSuccess && <Notice>{tCommon('state.saved')}</Notice>}
        <Field label={t('profile.fullName')} autoComplete="name" {...form.register('fullName')} />
        <Field
          label={t('profile.email')}
          type="email"
          autoComplete="email"
          error={errors.email?.message ? tError(errors.email.message as never) : undefined}
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
  const { t: tError } = useTranslation('errors')
  const change = useChangePassword()

  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })
  const { errors } = form.formState
  const fieldError = (message?: string) => (message ? tError(message as never) : undefined)

  const submit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await change.mutateAsync({ data: { currentPassword, newPassword } })
    } catch {
      return // shown by ErrorMessage via change.error
    }
    form.reset()
  })

  return (
    <Section title={t('profile.password')} description={t('profile.passwordDescription')}>
      <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
        <ErrorMessage error={change.error} />
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
