import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ApiFieldMap } from './form-errors'
import { useErrorMessage } from './use-error-message'

type PageProps = {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

/** Every page: header with title and actions, then content. */
export function Page({ title, description, actions, children }: PageProps) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-control border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm text-muted">{title}</p>
      {action}
    </div>
  )
}

export function Loading() {
  const { t } = useTranslation()
  return (
    <p role="status" className="py-12 text-center text-sm text-muted">
      {t('state.loading')}
    </p>
  )
}

/** A translated API error. `fields`: the form fields that show per-field errors (see setApiFieldErrors). */
export function ErrorMessage({ error, fields }: { error: unknown; fields?: ApiFieldMap }) {
  const message = useErrorMessage()
  if (!error) return null
  return (
    <p role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message(error, fields)}
    </p>
  )
}

/** A short confirmation shown after an action succeeded. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-control border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
      {children}
    </p>
  )
}
