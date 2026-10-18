import * as LabelPrimitive from '@radix-ui/react-label'
import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-control border border-line bg-surface px-3 text-sm outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}

type FieldProps = ComponentProps<'input'> & {
  label: string
  error?: string
  hint?: string
  /** Shown inside the input at the end, e.g. a unit ("mA") or currency. */
  suffix?: string
}

/** Label + input + hint/error, wired for accessibility. */
export function Field({ label, error, hint, suffix, id, ...props }: FieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const message = error || hint
  return (
    <div className="group/field space-y-1.5">
      <LabelPrimitive.Root htmlFor={inputId} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      {suffix ? (
        <div className="relative">
          <Input
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            className="pr-12"
            {...props}
          />
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted">
            {suffix}
          </span>
        </div>
      ) : (
        <Input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={message ? messageId : undefined} {...props} />
      )}
      {message && (
        <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
