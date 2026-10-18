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

/**
 * A translated API error. `fields`: the form fields that show per-field errors
 * (see setApiFieldErrors). `action`: a way out shown next to the text, e.g. a
 * Reload button.
 */
export function ErrorMessage({ error, fields, action }: { error: unknown; fields?: ApiFieldMap; action?: ReactNode }) {
  const message = useErrorMessage()
  if (!error) return null
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <p>{message(error, fields)}</p>
      {action}
    </div>
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
