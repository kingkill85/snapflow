import * as LabelPrimitive from '@radix-ui/react-label'
import { ChevronDown } from 'lucide-react'
import { type ComponentProps, useId } from 'react'

import { cn } from '@/lib/cn'

export type SelectOption = { value: string; label: string }

type SelectProps = Omit<ComponentProps<'select'>, 'children'> & { options: SelectOption[] }

/** A native select styled like Input; options are value/label pairs. */
export function Select({ className, options, ...props }: SelectProps) {
  return (
    <div className={cn('relative', className)}>
      <select
        className="h-9 w-full appearance-none rounded-control border border-line bg-surface pr-8 pl-3 text-sm outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger"
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" />
    </div>
  )
}

type SelectFieldProps = SelectProps & { label: string; error?: string; hint?: string }

/** Label + select + hint/error, wired for accessibility. */
export function SelectField({ label, error, hint, id, ...props }: SelectFieldProps) {
  const generated = useId()
  const selectId = id ?? generated
  const messageId = `${selectId}-message`
  const message = error || hint
  return (
    <div className="group/field space-y-1.5">
      <LabelPrimitive.Root htmlFor={selectId} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      <Select id={selectId} aria-invalid={error ? true : undefined} aria-describedby={message ? messageId : undefined} {...props} />
      {message && (
        <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
