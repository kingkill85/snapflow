import * as LabelPrimitive from '@radix-ui/react-label'
import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

/** A multi-line text input styled like Input. */
export function Textarea({ className, rows = 3, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      rows={rows}
      className={cn(
        'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}

type TextareaFieldProps = ComponentProps<'textarea'> & { label: string; error?: string; hint?: string }

/** Label + textarea + hint/error, wired for accessibility (the multi-line Field). */
export function TextareaField({ label, error, hint, id, ...props }: TextareaFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const message = error || hint
  return (
    <div className="group/field space-y-1.5">
      <LabelPrimitive.Root htmlFor={inputId} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      <Textarea id={inputId} aria-invalid={error ? true : undefined} aria-describedby={message ? messageId : undefined} {...props} />
      {message && (
        <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
