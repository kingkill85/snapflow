import * as LabelPrimitive from '@radix-ui/react-label'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

/**
 * The red asterisk after a required field's label. It sits outside the label
 * element, so the field's accessible name stays the label alone; the input
 * carries `aria-required` (a group a description) for screen readers.
 */
export function RequiredMark() {
  const { t } = useTranslation()
  return (
    <span aria-hidden="true" title={t('state.required')} className="text-danger">
      *
    </span>
  )
}

type FieldLabelProps = {
  /** The input the label names; without it the label is plain text (e.g. for a group, referenced by `id`). */
  htmlFor?: string
  id?: string
  required?: boolean
  /** Shown at the end of the label row, e.g. the language tabs of a TranslatableField. */
  end?: ReactNode
  children: ReactNode
}

/** A field's label row: the label, the required mark, optional controls at the end. */
export function FieldLabel({ htmlFor, id, required, end, children }: FieldLabelProps) {
  const label = (
    <span className="inline-flex items-baseline gap-0.5">
      {htmlFor ? (
        <LabelPrimitive.Root id={id} htmlFor={htmlFor} className="text-sm font-medium">
          {children}
        </LabelPrimitive.Root>
      ) : (
        <span id={id} className="text-sm font-medium">
          {children}
        </span>
      )}
      {required && <RequiredMark />}
    </span>
  )
  if (!end) return <div>{label}</div>
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      {label}
      {end}
    </div>
  )
}

/** The hint or error under a field (hints are hidden while the field is disabled, i.e. read-only). */
export function FieldMessage({ id, error, hint, className }: { id: string; error?: string; hint?: string; className?: string }) {
  const message = error || hint
  if (!message) return null
  return (
    <p id={id} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden', className)}>
      {message}
    </p>
  )
}
