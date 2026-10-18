import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import type { ApiFieldMap } from './form-errors'
import { useErrorMessage } from './use-error-message'

type PageProps = {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  /**
   * `wide` for list and data pages, so tables get the screen (D95); the
   * default keeps forms and editors at a readable width; `narrow` for a
   * single column of short forms, e.g. the profile (D116).
   */
  width?: 'default' | 'wide' | 'narrow'
}

/** Every page: header with title and actions, then content. */
export function Page({ title, description, actions, width = 'default', children }: PageProps) {
  return (
    <div className={cn('mx-auto w-full space-y-6 px-4 py-6 sm:px-6', { wide: 'max-w-[96rem]', default: 'max-w-6xl', narrow: 'max-w-3xl' }[width])}>
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

/**
 * A short message: a confirmation after an action succeeded (default), or a
 * warning about what an input will do (`tone="warning"`).
 */
export function Notice({ tone = 'success', children }: { tone?: 'success' | 'warning'; children: ReactNode }) {
  return (
    <p
      role="status"
      className={cn(
        'rounded-control border px-3 py-2 text-sm',
        tone === 'success' ? 'border-success/40 bg-success/10 text-success' : 'border-warning/50 bg-warning/10 text-ink',
      )}
    >
      {children}
    </p>
  )
}
