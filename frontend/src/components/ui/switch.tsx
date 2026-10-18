import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

type SwitchFieldProps = Omit<ComponentProps<'input'>, 'type' | 'role'> & { label: string; hint?: string; error?: string }

/**
 * An on/off setting of the whole record, e.g. "Active" (D112): a switch with
 * its label and hint beside it, above a divider line. It is a native checkbox
 * with role="switch", so `form.register` binds it like a checkbox. Editors put
 * it as the last row of their first section (dialogs: as their last field),
 * across the full width.
 */
export function SwitchField({ label, hint, error, id, className, ...props }: SwitchFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const message = error || hint
  return (
    <div className={cn('group/field flex items-start gap-3 border-t border-line pt-4', className)}>
      {/* The track is a label too, so clicking it toggles; it adds no text to the name. Off it is solid muted,
          on primary, the knob raised: each at least 3:1 against its neighbour (WCAG 1.4.11, contrast.test.ts). */}
      <label
        htmlFor={inputId}
        className="group/switch relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-muted transition-colors has-checked:bg-primary has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus has-disabled:cursor-not-allowed has-disabled:opacity-50"
      >
        <input
          id={inputId}
          type="checkbox"
          role="switch"
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          // Invisible but covering the track: clicks and taps land on the input itself.
          className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-full opacity-0 disabled:cursor-not-allowed"
          {...props}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none size-4 translate-x-0.5 rounded-full bg-raised shadow-sm transition-transform group-has-checked/switch:translate-x-[1.125rem]"
        />
      </label>
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={inputId} className="block cursor-pointer text-sm font-medium group-has-disabled/field:cursor-not-allowed">
          {label}
        </label>
        {message && (
          <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
