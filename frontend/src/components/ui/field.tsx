import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

import { FieldLabel, FieldMessage } from './label'

export const inputClass =
  'h-9 w-full rounded-control border border-line bg-surface px-3 text-sm outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(inputClass, className)} {...props} />
}

type FieldProps = ComponentProps<'input'> & {
  label: string
  error?: string
  hint?: string
  /** Shown inside the input at the end, e.g. a unit ("mA") or currency. */
  suffix?: string
  /** Marks the label with an asterisk and the input with aria-required; checking stays with the form (noValidate). */
  required?: boolean
}

/** Label + input + hint/error, wired for accessibility. */
export function Field({ label, error, hint, suffix, required, id, 'aria-required': ariaRequired, ...props }: FieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const input = (
    <Input
      id={inputId}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? messageId : undefined}
      aria-required={required || ariaRequired || undefined}
      className={suffix ? 'pr-12' : undefined}
      {...props}
    />
  )
  return (
    <div className="group/field min-w-0 space-y-1.5">
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      {suffix ? (
        <div className="relative">
          {input}
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted">
            {suffix}
          </span>
        </div>
      ) : (
        input
      )}
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  )
}
