import { type ComponentProps, useId } from 'react'

type CheckboxFieldProps = Omit<ComponentProps<'input'>, 'type'> & { label: string; hint?: string }

/** A checkbox with its label on the right and an optional hint below. */
export function CheckboxField({ label, hint, id, ...props }: CheckboxFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  return (
    <div className="group/field space-y-1">
      <label htmlFor={inputId} className="flex items-center gap-2 text-sm font-medium">
        <input id={inputId} type="checkbox" className="size-4 rounded accent-primary disabled:opacity-50" {...props} />
        {label}
      </label>
      {hint && <p className="pl-6 text-xs text-muted group-has-[:disabled]/field:hidden">{hint}</p>}
    </div>
  )
}
