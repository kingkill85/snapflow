import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { z } from 'zod'

import { getGetMeQueryKey, useLogin } from '@/api/generated/auth/auth'
import { useSession } from '@/app/session'
import { apiFields, Button, errorKey, ErrorMessage, Field, setApiFieldErrors, useFieldError } from '@/components/ui'

import { safeReturnTo } from './return-to'

const schema = z.object({
  email: z.string().trim().min(1, errorKey('validation.required')).max(254, errorKey('validation.too_long', { max: 254 })),
  password: z.string().min(1, errorKey('validation.required')).max(200, errorKey('validation.too_long', { max: 200 })),
})
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['email', 'password'])

export function LoginPage() {
  const { t } = useTranslation('auth')
  const fieldError = useFieldError()
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('returnTo'))
  // A failed login says nothing about a session; don't re-check it.
  const login = useLogin({ mutation: { meta: { skipSessionCheck: true } } })

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } })
  const { errors } = form.formState

  const submit = form.handleSubmit(async (data) => {
    let me
    try {
      me = await login.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via login.error
    }
    // Start clean: nothing cached for a previous user survives a login.
    queryClient.clear()
    queryClient.setQueryData(getGetMeQueryKey(), me)
    void navigate(returnTo, { replace: true })
  })

  if (session.me) return <Navigate to={returnTo} replace />

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-control border border-line bg-surface p-8 shadow-sm">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
          <p className="text-sm text-muted">{t('login.subtitle')}</p>
        </div>
        <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
          <ErrorMessage error={login.error} fields={fields} />
          <Field
            label={t('login.email')}
            type="email"
            autoComplete="username"
            autoFocus
            error={fieldError(errors.email?.message)}
            {...form.register('email')}
          />
          <Field
            label={t('login.password')}
            type="password"
            autoComplete="current-password"
            error={fieldError(errors.password?.message)}
            {...form.register('password')}
          />
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {t('login.submit')}
          </Button>
        </form>
      </div>
    </main>
  )
}
