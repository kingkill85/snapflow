import * as LabelPrimitive from '@radix-ui/react-label'
import { Plus, X } from 'lucide-react'
import { type ComponentProps, type KeyboardEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { Button } from './button'
import { Input } from './field'
import { IconButton } from './icon-button'

type TagsFieldProps = {
  label: string
  /** The items, in order. */
  value: string[]
  onChange: (value: string[]) => void
  error?: string
  hint?: string
  disabled?: boolean
  /** Shown after each item, e.g. a unit. */
  suffix?: string
  inputMode?: ComponentProps<'input'>['inputMode']
}

/**
 * A list of short values typed one by one (e.g. a list of numbers): each is
 * added with Enter, the Add button or by leaving the input, and shown as a
 * removable chip.
 */
export function TagsField({ label, value, onChange, error, hint, disabled, suffix, inputMode }: TagsFieldProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const messageId = `${inputId}-message`
  const labelId = `${inputId}-label`
  const message = error || hint
  const [draft, setDraft] = useState('')

  const add = () => {
    const item = draft.trim()
    if (item === '') return
    onChange([...value, item])
    setDraft('')
  }
  const keyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault() // not the form's submit
    add()
  }

  return (
    <div className="group/field space-y-1.5">
      {disabled ? (
        // No input to label: the label names the list instead.
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
      ) : (
        <LabelPrimitive.Root htmlFor={inputId} className="text-sm font-medium">
          {label}
        </LabelPrimitive.Root>
      )}
      {value.length > 0 && (
        <ul aria-labelledby={disabled ? labelId : undefined} className="flex flex-wrap gap-1.5">
          {value.map((item, i) => (
            <li key={`${i}:${item}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pr-0.5 pl-2.5 text-sm">
              {suffix ? `${item} ${suffix}` : item}
              {!disabled && (
                <IconButton
                  label={t('action.removeItem', { item })}
                  icon={<X />}
                  className="size-6"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={draft}
            inputMode={inputMode}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keyDown}
            onBlur={add}
            aria-invalid={error ? true : undefined}
            aria-describedby={message ? messageId : undefined}
          />
          <Button variant="secondary" onClick={add} disabled={draft.trim() === ''}>
            <Plus /> {t('action.add')}
          </Button>
        </div>
      )}
      {disabled && value.length === 0 && <p className="text-sm text-muted">{t('state.none')}</p>}
      {message && (
        <p
          id={messageId}
          data-field-error={error && disabled ? true : undefined}
          className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}
        >
          {message}
        </p>
      )}
    </div>
  )
}
