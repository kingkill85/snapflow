import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

type CheckboxFieldProps = Omit<ComponentProps<'input'>, 'type'> & { label: string; hint?: string; error?: string }

/** A checkbox with its label on the right and an optional hint or error below. */
export function CheckboxField({ label, hint, error, id, ...props }: CheckboxFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const message = error || hint
  return (
    <div className="group/field space-y-1">
      <label htmlFor={inputId} className="flex items-center gap-2 text-sm font-medium">
        <input
          id={inputId}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className="size-4 rounded accent-primary disabled:opacity-50"
          {...props}
        />
        {label}
      </label>
      {message && (
        <p id={messageId} className={cn('pl-6 text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
