import { useId } from 'react'

import { cn } from '@/lib/cn'

import { CheckboxField } from './checkbox'
import type { SelectOption } from './select'

type CheckboxGroupFieldProps = {
  label: string
  options: SelectOption[]
  /** The checked option values, in option order. */
  value: string[]
  onChange: (value: string[]) => void
  error?: string
  hint?: string
  disabled?: boolean
}

/** Several options of which any number can be chosen: a group of checkboxes with one label. */
export function CheckboxGroupField({ label, options, value, onChange, error, hint, disabled }: CheckboxGroupFieldProps) {
  const messageId = useId()
  const message = error || hint
  const checked = new Set(value)
  const toggle = (option: string, on: boolean) => {
    const next = new Set(checked)
    if (on) next.add(option)
    else next.delete(option)
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value))
  }
  return (
    <fieldset className="group/field min-w-0 space-y-1.5" disabled={disabled} aria-describedby={message ? messageId : undefined}>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((o) => (
          <CheckboxField
            key={o.value}
            label={o.label}
            checked={checked.has(o.value)}
            onChange={(e) => toggle(o.value, e.target.checked)}
            aria-invalid={error ? true : undefined}
          />
        ))}
      </div>
      {message && (
        <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </fieldset>
  )
}
