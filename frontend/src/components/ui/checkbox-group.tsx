import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { CheckboxField } from './checkbox'
import { RequiredMark } from './label'
import type { SelectOption } from './select'

type CheckboxGroupFieldProps = {
  label: string
  options: SelectOption[]
  /**
   * The checked values, in option order. Values that are not options (e.g.
   * an option removed since) show as checked boxes after the options, labelled
   * by `unknownLabel`; unticking one removes it.
   */
  value: string[]
  onChange: (value: string[]) => void
  /** The label of a checked value that is not an option; "<value> (not an option)" by default. */
  unknownLabel?: (value: string) => string
  error?: string
  hint?: string
  disabled?: boolean
  /** Marks the legend with an asterisk; screen readers hear "Required" with the group's description. */
  required?: boolean
}

/** Several options of which any number can be chosen: a group of checkboxes with one label. */
export function CheckboxGroupField({ label, options, value, onChange, unknownLabel, error, hint, disabled, required }: CheckboxGroupFieldProps) {
  const { t } = useTranslation()
  const messageId = useId()
  const requiredId = useId()
  const message = error || hint
  const describedBy = [required ? requiredId : '', message ? messageId : ''].filter(Boolean).join(' ') || undefined
  const checked = new Set(value)
  const known = new Set(options.map((o) => o.value))
  const unknown = [...new Set(value.filter((v) => !known.has(v)))]
  const unknownText = unknownLabel ?? ((v: string) => t('option.unknown', { value: v }))
  const toggle = (option: string, on: boolean) => {
    const next = new Set(checked)
    if (on) next.add(option)
    else next.delete(option)
    // Options in their order, then the unknown values still checked.
    onChange([...options.map((o) => o.value), ...unknown].filter((v) => next.has(v)))
  }
  return (
    <fieldset className="group/field min-w-0 space-y-1.5" disabled={disabled} aria-describedby={describedBy}>
      <legend className="mb-1.5 text-sm font-medium">
        {label}
        {required && <RequiredMark />}
      </legend>
      {required && (
        <span id={requiredId} className="sr-only">
          {t('state.required')}
        </span>
      )}
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
        {unknown.map((v) => (
          <CheckboxField
            key={`unknown:${v}`}
            label={unknownText(v)}
            checked
            onChange={(e) => toggle(v, e.target.checked)}
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
